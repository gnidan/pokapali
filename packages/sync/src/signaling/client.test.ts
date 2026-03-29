import { describe, it, expect, vi } from "vitest";
import { SignalType, encodeSignal, decodeSignal } from "./protocol.js";
import { createSignalingClient, frameLengthPrefix } from "./client.js";

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

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 50));
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe("SignalingClient", () => {
  it("joinRoom sends JOIN_ROOM to stream", async () => {
    const stream = createMockStream();
    const client = createSignalingClient(stream);

    client.joinRoom("room1");
    await tick();

    const msgs = decodeSinkMessages(stream.sinkData);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.type).toBe(SignalType.JOIN_ROOM);
    if (msgs[0]!.type === SignalType.JOIN_ROOM) {
      expect(msgs[0]!.room).toBe("room1");
    }

    client.destroy();
  });

  it("leaveRoom sends LEAVE_ROOM to stream", async () => {
    const stream = createMockStream();
    const client = createSignalingClient(stream);

    client.joinRoom("room1");
    await tick();
    stream.sinkData.length = 0;

    client.leaveRoom("room1");
    await tick();

    const msgs = decodeSinkMessages(stream.sinkData);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.type).toBe(SignalType.LEAVE_ROOM);
    if (msgs[0]!.type === SignalType.LEAVE_ROOM) {
      expect(msgs[0]!.room).toBe("room1");
    }

    client.destroy();
  });

  it("sendSignal sends SIGNAL with target to stream", async () => {
    const stream = createMockStream();
    const client = createSignalingClient(stream);

    const payload = new Uint8Array([1, 2, 3]);
    client.sendSignal("room1", "peer-b", payload);
    await tick();

    const msgs = decodeSinkMessages(stream.sinkData);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.type).toBe(SignalType.SIGNAL);
    if (msgs[0]!.type === SignalType.SIGNAL) {
      expect(msgs[0]!.room).toBe("room1");
      expect(msgs[0]!.targetPeerId).toBe("peer-b");
      expect(msgs[0]!.payload).toEqual(payload);
    }

    client.destroy();
  });

  it("onPeerJoined fires when PEER_JOINED " + "received", async () => {
    const stream = createMockStream();
    const client = createSignalingClient(stream);

    const joined: { room: string; peerId: string }[] = [];
    client.onPeerJoined((room, peerId) => {
      joined.push({ room, peerId });
    });

    stream.pushMessage(
      encodeSignal({
        type: SignalType.PEER_JOINED,
        room: "room1",
        peerId: "peer-a",
      }),
    );
    await tick();

    expect(joined).toHaveLength(1);
    expect(joined[0]).toEqual({
      room: "room1",
      peerId: "peer-a",
    });

    client.destroy();
  });

  it("onPeerLeft fires when PEER_LEFT received", async () => {
    const stream = createMockStream();
    const client = createSignalingClient(stream);

    const left: { room: string; peerId: string }[] = [];
    client.onPeerLeft((room, peerId) => {
      left.push({ room, peerId });
    });

    stream.pushMessage(
      encodeSignal({
        type: SignalType.PEER_LEFT,
        room: "room1",
        peerId: "peer-a",
      }),
    );
    await tick();

    expect(left).toHaveLength(1);
    expect(left[0]).toEqual({
      room: "room1",
      peerId: "peer-a",
    });

    client.destroy();
  });

  it("onSignal fires with fromPeerId when " + "SIGNAL received", async () => {
    const stream = createMockStream();
    const client = createSignalingClient(stream);

    const signals: {
      room: string;
      fromPeerId: string;
      payload: Uint8Array;
    }[] = [];
    client.onSignal((room, fromPeerId, payload) => {
      signals.push({ room, fromPeerId, payload });
    });

    // Relay sends SIGNAL with targetPeerId =
    // the original sender (relay rewrites)
    const payload = new Uint8Array([10, 20, 30]);
    stream.pushMessage(
      encodeSignal({
        type: SignalType.SIGNAL,
        room: "room1",
        targetPeerId: "peer-a",
        payload,
      }),
    );
    await tick();

    expect(signals).toHaveLength(1);
    expect(signals[0]!.room).toBe("room1");
    // targetPeerId from relay = fromPeerId
    expect(signals[0]!.fromPeerId).toBe("peer-a");
    expect(signals[0]!.payload).toEqual(payload);

    client.destroy();
  });

  it("unsubscribe removes callback", async () => {
    const stream = createMockStream();
    const client = createSignalingClient(stream);

    const joined: string[] = [];
    const unsub = client.onPeerJoined((_room, peerId) => {
      joined.push(peerId);
    });

    stream.pushMessage(
      encodeSignal({
        type: SignalType.PEER_JOINED,
        room: "room1",
        peerId: "peer-a",
      }),
    );
    await tick();
    expect(joined).toHaveLength(1);

    unsub();

    stream.pushMessage(
      encodeSignal({
        type: SignalType.PEER_JOINED,
        room: "room1",
        peerId: "peer-b",
      }),
    );
    await tick();
    // Should still be 1 — callback removed
    expect(joined).toHaveLength(1);

    client.destroy();
  });

  it("destroy sends LEAVE_ROOM for all " + "joined rooms", async () => {
    const stream = createMockStream();
    const client = createSignalingClient(stream);

    client.joinRoom("room-a");
    client.joinRoom("room-b");
    await tick();
    stream.sinkData.length = 0;

    client.destroy();
    await tick();

    const msgs = decodeSinkMessages(stream.sinkData);
    const leaveRooms = msgs
      .filter((m) => m.type === SignalType.LEAVE_ROOM)
      .map((m) => (m.type === SignalType.LEAVE_ROOM ? m.room : ""));
    expect(leaveRooms.sort()).toEqual(["room-a", "room-b"].sort());
  });

  it(
    "destroy does not send LEAVE_ROOM for " + "already-left rooms",
    async () => {
      const stream = createMockStream();
      const client = createSignalingClient(stream);

      client.joinRoom("room-a");
      client.joinRoom("room-b");
      await tick();

      client.leaveRoom("room-a");
      await tick();
      stream.sinkData.length = 0;

      client.destroy();
      await tick();

      const msgs = decodeSinkMessages(stream.sinkData);
      const leaveRooms = msgs
        .filter((m) => m.type === SignalType.LEAVE_ROOM)
        .map((m) => (m.type === SignalType.LEAVE_ROOM ? m.room : ""));
      expect(leaveRooms).toEqual(["room-b"]);
    },
  );

  it("stream close notifies via onClose callback", async () => {
    const stream = createMockStream();
    const client = createSignalingClient(stream);

    const closed = vi.fn();
    client.onClose(closed);

    stream.end();
    await tick();

    expect(closed).toHaveBeenCalledOnce();

    client.destroy();
  });
});
