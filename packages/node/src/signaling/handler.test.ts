import { describe, it, expect, vi } from "vitest";
import { SignalType, encodeSignal, decodeSignal } from "./protocol.js";
import { createRoomRegistry } from "./registry.js";
import {
  handleSignalingStream,
  frameLengthPrefix,
  createFrameReader,
} from "./handler.js";

// -------------------------------------------------------
// Mock stream helpers
// -------------------------------------------------------

interface MockStream {
  source: AsyncIterable<{ subarray(): Uint8Array }>;
  sink: (source: AsyncIterable<Uint8Array>) => Promise<void>;
  close(): void;
  /** Push a framed message into the source */
  pushMessage(bytes: Uint8Array): void;
  /** Signal end of source */
  end(): void;
  /** Collect all bytes written to sink */
  sinkData: Uint8Array[];
}

function createMockStream(): MockStream {
  const chunks: Uint8Array[] = [];
  let resolve: (() => void) | null = null;
  let done = false;

  const stream: MockStream = {
    source: {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            while (chunks.length === 0 && !done) {
              await new Promise<void>((r) => {
                resolve = r;
              });
            }
            if (chunks.length > 0) {
              const value = chunks.shift()!;
              return {
                done: false,
                value: {
                  subarray: () => value,
                },
              };
            }
            return {
              done: true,
              value: undefined,
            };
          },
        };
      },
    },
    sinkData: [],
    async sink(source: AsyncIterable<Uint8Array>) {
      for await (const chunk of source) {
        stream.sinkData.push(chunk);
      }
    },
    close() {
      done = true;
      if (resolve) resolve();
    },
    pushMessage(bytes: Uint8Array) {
      chunks.push(frameLengthPrefix(bytes));
      if (resolve) {
        const r = resolve;
        resolve = null;
        r();
      }
    },
    end() {
      done = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r();
      }
    },
  };

  return stream;
}

function decodeSinkMessages(
  sinkData: Uint8Array[],
): ReturnType<typeof decodeSignal>[] {
  const msgs: ReturnType<typeof decodeSignal>[] = [];
  let buffer = new Uint8Array(0);
  for (const chunk of sinkData) {
    const next = new Uint8Array(buffer.length + chunk.length);
    next.set(buffer, 0);
    next.set(chunk, buffer.length);
    buffer = next;
  }
  while (buffer.length >= 4) {
    const len = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0);
    if (buffer.length < 4 + len) break;
    msgs.push(decodeSignal(buffer.slice(4, 4 + len)));
    buffer = buffer.slice(4 + len);
  }
  return msgs;
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe("signaling handler", () => {
  it("JOIN_ROOM notifies existing members", async () => {
    const registry = createRoomRegistry();
    const notified: Uint8Array[] = [];

    // Pre-register peer A in the room
    registry.join("room1", {
      peerId: "peer-a",
      send: (bytes) => notified.push(bytes),
    });

    // Peer B joins via stream
    const stream = createMockStream();
    handleSignalingStream("peer-b", stream, { registry });

    stream.pushMessage(
      encodeSignal({
        type: SignalType.JOIN_ROOM,
        room: "room1",
      }),
    );

    // Give handler time to process
    await tick();

    // Peer A should receive PEER_JOINED
    // notification for peer-b (raw encoded,
    // not length-prefixed — external peers
    // get raw bytes from registry.send)
    expect(notified.length).toBeGreaterThan(0);
    const decoded = decodeSignal(notified[0]!);
    expect(decoded.type).toBe(SignalType.PEER_JOINED);
    if (decoded.type === SignalType.PEER_JOINED) {
      expect(decoded.room).toBe("room1");
      expect(decoded.peerId).toBe("peer-b");
    }

    stream.end();
  });

  it("JOIN_ROOM notifies joiner about " + "existing members", async () => {
    const registry = createRoomRegistry();
    registry.join("room1", {
      peerId: "peer-a",
      send: vi.fn(),
    });

    const stream = createMockStream();
    handleSignalingStream("peer-b", stream, { registry });

    stream.pushMessage(
      encodeSignal({
        type: SignalType.JOIN_ROOM,
        room: "room1",
      }),
    );

    await tick();

    // Peer B's sink should have PEER_JOINED for
    // peer-a (existing member notification)
    const msgs = decodeSinkMessages(stream.sinkData);
    const joinedMsgs = msgs.filter((m) => m.type === SignalType.PEER_JOINED);
    expect(joinedMsgs).toHaveLength(1);
    if (joinedMsgs[0]!.type === SignalType.PEER_JOINED) {
      expect(joinedMsgs[0]!.peerId).toBe("peer-a");
    }

    stream.end();
  });

  it("SIGNAL forwards to target peer", async () => {
    const registry = createRoomRegistry();
    const targetReceived: Uint8Array[] = [];

    registry.join("room1", {
      peerId: "peer-a",
      send: vi.fn(),
    });
    registry.join("room1", {
      peerId: "peer-b",
      send: (bytes) => targetReceived.push(bytes),
    });

    // Peer A sends SIGNAL to peer B
    const stream = createMockStream();
    // Register peer A's stream entry so it
    // can send
    registry.leave("room1", "peer-a");
    registry.join("room1", {
      peerId: "peer-a",
      send: vi.fn(),
    });

    handleSignalingStream("peer-a", stream, { registry });

    const payload = new Uint8Array([1, 2, 3, 4]);
    stream.pushMessage(
      encodeSignal({
        type: SignalType.SIGNAL,
        room: "room1",
        targetPeerId: "peer-b",
        payload,
      }),
    );

    await tick();

    expect(targetReceived.length).toBeGreaterThan(0);
    const decoded = decodeSignal(targetReceived[0]!);
    expect(decoded.type).toBe(SignalType.SIGNAL);
    if (decoded.type === SignalType.SIGNAL) {
      expect(decoded.room).toBe("room1");
      // Target receives signal with sender's
      // peerId as targetPeerId (reverse route)
      expect(decoded.targetPeerId).toBe("peer-a");
      expect(decoded.payload).toEqual(payload);
    }

    stream.end();
  });

  it("stream close sends PEER_LEFT to " + "remaining members", async () => {
    const registry = createRoomRegistry();
    const aReceived: Uint8Array[] = [];

    registry.join("room1", {
      peerId: "peer-a",
      send: (bytes) => aReceived.push(bytes),
    });

    const stream = createMockStream();
    handleSignalingStream("peer-b", stream, { registry });

    // Peer B joins the room
    stream.pushMessage(
      encodeSignal({
        type: SignalType.JOIN_ROOM,
        room: "room1",
      }),
    );
    await tick();

    // Clear previous notifications
    aReceived.length = 0;

    // Peer B disconnects
    stream.end();
    await tick();

    // Peer A should receive PEER_LEFT
    expect(aReceived.length).toBeGreaterThan(0);
    const decoded = decodeSignal(aReceived[aReceived.length - 1]!);
    expect(decoded.type).toBe(SignalType.PEER_LEFT);
    if (decoded.type === SignalType.PEER_LEFT) {
      expect(decoded.room).toBe("room1");
      expect(decoded.peerId).toBe("peer-b");
    }
  });

  it("signals don't leak across rooms", async () => {
    const registry = createRoomRegistry();
    const roomBReceived: Uint8Array[] = [];

    registry.join("room-a", {
      peerId: "peer-x",
      send: vi.fn(),
    });
    registry.join("room-b", {
      peerId: "peer-y",
      send: (bytes) => roomBReceived.push(bytes),
    });

    const stream = createMockStream();
    handleSignalingStream("peer-z", stream, { registry });

    // Peer Z sends signal to peer-y but in
    // room-a (wrong room)
    stream.pushMessage(
      encodeSignal({
        type: SignalType.SIGNAL,
        room: "room-a",
        targetPeerId: "peer-y",
        payload: new Uint8Array([99]),
      }),
    );

    await tick();

    // Peer Y in room-b should NOT receive it
    expect(roomBReceived).toHaveLength(0);

    stream.end();
  });

  it("LEAVE_ROOM sends PEER_LEFT", async () => {
    const registry = createRoomRegistry();
    const aReceived: Uint8Array[] = [];

    registry.join("room1", {
      peerId: "peer-a",
      send: (bytes) => aReceived.push(bytes),
    });

    const stream = createMockStream();
    handleSignalingStream("peer-b", stream, { registry });

    // Peer B joins
    stream.pushMessage(
      encodeSignal({
        type: SignalType.JOIN_ROOM,
        room: "room1",
      }),
    );
    await tick();
    aReceived.length = 0;

    // Peer B leaves explicitly
    stream.pushMessage(
      encodeSignal({
        type: SignalType.LEAVE_ROOM,
        room: "room1",
      }),
    );
    await tick();

    expect(aReceived.length).toBeGreaterThan(0);
    const decoded = decodeSignal(aReceived[0]!);
    expect(decoded.type).toBe(SignalType.PEER_LEFT);
    if (decoded.type === SignalType.PEER_LEFT) {
      expect(decoded.peerId).toBe("peer-b");
    }

    stream.end();
  });
});

describe("frame encoding", () => {
  it("frameLengthPrefix creates 4-byte header", () => {
    const data = new Uint8Array([1, 2, 3]);
    const framed = frameLengthPrefix(data);
    expect(framed.length).toBe(7);
    const len = new DataView(framed.buffer).getUint32(0);
    expect(len).toBe(3);
    expect(framed.slice(4)).toEqual(data);
  });

  it("createFrameReader reassembles " + "split chunks", async () => {
    const msg1 = new Uint8Array([10, 20, 30]);
    const msg2 = new Uint8Array([40, 50]);
    const frame1 = frameLengthPrefix(msg1);
    const frame2 = frameLengthPrefix(msg2);

    // Combine and split at arbitrary boundary
    const combined = new Uint8Array(frame1.length + frame2.length);
    combined.set(frame1, 0);
    combined.set(frame2, frame1.length);

    const splitAt = 5;
    const chunk1 = combined.slice(0, splitAt);
    const chunk2 = combined.slice(splitAt);

    const source = (async function* () {
      yield { subarray: () => chunk1 };
      yield { subarray: () => chunk2 };
    })();

    const frames: Uint8Array[] = [];
    for await (const f of createFrameReader(source)) {
      frames.push(f);
    }

    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual(msg1);
    expect(frames[1]).toEqual(msg2);
  });
});

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 50));
}
