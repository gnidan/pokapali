import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { MessageType, type Message } from "./messages.js";
import {
  createTransport,
  encodeFrame,
  encodeSnapshotFrame,
  decodeFrame,
  createReconcileChannel,
  type SnapshotMessage,
} from "./transport.js";

// -------------------------------------------------------
// Mock RTCDataChannel
// -------------------------------------------------------

type AnyFn = (...args: any[]) => any;

interface MockDataChannel extends RTCDataChannel {
  _listeners: Map<string, Set<AnyFn>>;
  _sent: Uint8Array[];
  _fire(event: string, data?: unknown): void;
  _setReadyState(state: RTCDataChannelState): void;
}

function mockDataChannel(): MockDataChannel {
  const listeners = new Map<string, Set<AnyFn>>();
  const sent: Uint8Array[] = [];
  let state: RTCDataChannelState = "open";

  const dc = {
    get readyState() {
      return state;
    },
    label: "pokapali-reconcile",
    _listeners: listeners,
    _sent: sent,

    send(data: ArrayBuffer | Uint8Array) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      sent.push(bytes);
    },

    addEventListener(event: string, cb: AnyFn) {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(cb);
    },

    removeEventListener(event: string, cb: AnyFn) {
      listeners.get(event)?.delete(cb);
    },

    close() {
      state = "closed";
      dc._fire("close");
    },

    _fire(event: string, data?: unknown) {
      for (const cb of listeners.get(event) ?? []) {
        cb(data ?? {});
      }
    },

    _setReadyState(s: RTCDataChannelState) {
      state = s;
    },
  };

  return dc as unknown as MockDataChannel;
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe("transport", () => {
  describe("frame encoding", () => {
    it("round-trips channelName + message", () => {
      const msg: Message = {
        type: MessageType.RECONCILE_START,
        channel: "content",
        fingerprint: new Uint8Array(32),
        editCount: 5,
      };

      const frame = encodeFrame("content", msg);
      const decoded = decodeFrame(frame);

      expect(decoded.channelName).toBe("content");
      expect(decoded.message.type).toBe(MessageType.RECONCILE_START);
      if (decoded.message.type !== MessageType.RECONCILE_START) {
        throw new Error("unexpected");
      }
      expect(decoded.message.editCount).toBe(5);
    });

    it("property: arbitrary channelNames + " + "messages round-trip", () => {
      const channelNameArb = fc.string({
        minLength: 1,
        maxLength: 100,
      });
      const msgArb = fc.record({
        type: fc.constant(MessageType.RECONCILE_START),
        channel: fc.string({
          minLength: 1,
          maxLength: 50,
        }),
        fingerprint: fc.uint8Array({
          minLength: 32,
          maxLength: 32,
        }),
        editCount: fc.nat({ max: 10000 }),
      }) as fc.Arbitrary<Message>;

      fc.assert(
        fc.property(channelNameArb, msgArb, (channelName, msg) => {
          const frame = encodeFrame(channelName, msg);
          const decoded = decodeFrame(frame);
          expect(decoded.channelName).toBe(channelName);
          expect(decoded.message.type).toBe(msg.type);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe("send / onMessage", () => {
    it(
      "A.send → B.onMessage fires with correct " + "channelName + message",
      () => {
        const dcA = mockDataChannel();
        const dcB = mockDataChannel();

        const transportA = createTransport(dcA);
        const transportB = createTransport(dcB);

        const received: Array<{
          channelName: string;
          msg: Message;
        }> = [];
        transportB.onMessage((channelName, msg) => {
          received.push({ channelName, msg });
        });

        const msg: Message = {
          type: MessageType.RECONCILE_START,
          channel: "notes",
          fingerprint: new Uint8Array(32),
          editCount: 3,
        };

        transportA.send("notes", msg);

        // Simulate wire: deliver A's sent data to B
        for (const bytes of dcA._sent) {
          dcB._fire("message", {
            data: bytes.buffer,
          });
        }

        expect(received).toHaveLength(1);
        expect(received[0]!.channelName).toBe("notes");
        expect(received[0]!.msg.type).toBe(MessageType.RECONCILE_START);
      },
    );
  });

  describe("connection lifecycle", () => {
    it("connected reflects data channel state", () => {
      const dc = mockDataChannel();
      const transport = createTransport(dc);

      expect(transport.connected).toBe(true);

      dc._setReadyState("closed");
      dc._fire("close");

      expect(transport.connected).toBe(false);
    });

    it("onConnectionChange fires on state change", () => {
      const dc = mockDataChannel();
      const transport = createTransport(dc);

      const changes: boolean[] = [];
      transport.onConnectionChange((connected) => {
        changes.push(connected);
      });

      dc._setReadyState("closed");
      dc._fire("close");

      expect(changes).toEqual([false]);
    });
  });

  describe("destroy", () => {
    it("after destroy, onMessage callback is " + "not called", () => {
      const dc = mockDataChannel();
      const transport = createTransport(dc);

      let called = false;
      transport.onMessage(() => {
        called = true;
      });

      transport.destroy();

      // Simulate incoming message after destroy
      const msg: Message = {
        type: MessageType.RECONCILE_START,
        channel: "test",
        fingerprint: new Uint8Array(32),
        editCount: 0,
      };
      const frame = encodeFrame("test", msg);
      dc._fire("message", {
        data: frame.buffer,
      });

      expect(called).toBe(false);
    });
  });

  describe("binary data", () => {
    it("dataChannel.send receives Uint8Array", () => {
      const dc = mockDataChannel();
      const transport = createTransport(dc);

      const msg: Message = {
        type: MessageType.RECONCILE_START,
        channel: "test",
        fingerprint: new Uint8Array(32),
        editCount: 0,
      };

      transport.send("test", msg);

      expect(dc._sent).toHaveLength(1);
      expect(dc._sent[0]).toBeInstanceOf(Uint8Array);
    });
  });

  describe("keepalive", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("sends PING every 20s when channel is open", () => {
      const dc = mockDataChannel();
      const transport = createTransport(dc);

      // Already open → keepalive started
      dc._sent.length = 0;

      vi.advanceTimersByTime(20_000);
      expect(dc._sent).toHaveLength(1);
      expect(dc._sent[0]).toEqual(new Uint8Array([0x01]));

      vi.advanceTimersByTime(20_000);
      expect(dc._sent).toHaveLength(2);

      transport.destroy();
    });

    it("auto-responds to PING with PONG", () => {
      const dc = mockDataChannel();
      const transport = createTransport(dc);
      dc._sent.length = 0;

      // Simulate receiving PING
      dc._fire("message", {
        data: new Uint8Array([0x01]).buffer,
      });

      expect(dc._sent).toHaveLength(1);
      expect(dc._sent[0]).toEqual(new Uint8Array([0x02]));

      transport.destroy();
    });

    it("does not bubble keepalive to onMessage", () => {
      const dc = mockDataChannel();
      const transport = createTransport(dc);

      const received: unknown[] = [];
      transport.onMessage((ch, msg) => {
        received.push({ ch, msg });
      });

      // PING + PONG
      dc._fire("message", {
        data: new Uint8Array([0x01]).buffer,
      });
      dc._fire("message", {
        data: new Uint8Array([0x02]).buffer,
      });

      expect(received).toHaveLength(0);

      transport.destroy();
    });

    it("starts keepalive on open event", () => {
      const dc = mockDataChannel();
      dc._setReadyState("connecting");
      const transport = createTransport(dc);

      vi.advanceTimersByTime(20_000);
      expect(dc._sent).toHaveLength(0);

      // Channel opens
      dc._setReadyState("open");
      dc._fire("open");

      vi.advanceTimersByTime(20_000);
      expect(dc._sent).toHaveLength(1);
      expect(dc._sent[0]).toEqual(new Uint8Array([0x01]));

      transport.destroy();
    });

    it("stops keepalive on close", () => {
      const dc = mockDataChannel();
      const transport = createTransport(dc);

      // Verify running
      vi.advanceTimersByTime(20_000);
      expect(dc._sent).toHaveLength(1);
      dc._sent.length = 0;

      // Close
      dc._setReadyState("closed");
      dc._fire("close");

      vi.advanceTimersByTime(40_000);
      expect(dc._sent).toHaveLength(0);

      transport.destroy();
    });

    it("stops keepalive on destroy", () => {
      const dc = mockDataChannel();
      const transport = createTransport(dc);
      dc._sent.length = 0;

      transport.destroy();

      vi.advanceTimersByTime(40_000);
      expect(dc._sent).toHaveLength(0);
    });
  });

  describe("snapshot frames", () => {
    it("encodeSnapshotFrame writes channelNameLength=0", () => {
      const msg: SnapshotMessage = {
        type: MessageType.SNAPSHOT_REQUEST,
        cids: [new Uint8Array([1, 2, 3])],
      };
      const frame = encodeSnapshotFrame(msg);
      expect(frame[0]).toBe(0);
      expect(frame[1]).toBe(0);
    });

    it("decodeFrame on snapshot frame yields empty channel", () => {
      const msg: SnapshotMessage = {
        type: MessageType.SNAPSHOT_CATALOG,
        entries: [],
        tip: null,
      };
      const frame = encodeSnapshotFrame(msg);
      const { channelName, message } = decodeFrame(frame);
      expect(channelName).toBe("");
      expect(message.type).toBe(MessageType.SNAPSHOT_CATALOG);
    });

    it(
      "A.sendSnapshotMessage → " + "B.onSnapshotMessage fires with message",
      () => {
        const dcA = mockDataChannel();
        const dcB = mockDataChannel();

        const transportA = createTransport(dcA);
        const transportB = createTransport(dcB);

        const received: SnapshotMessage[] = [];
        transportB.onSnapshotMessage((msg) => {
          received.push(msg);
        });

        const msg: SnapshotMessage = {
          type: MessageType.SNAPSHOT_REQUEST,
          cids: [new Uint8Array([1, 2, 3, 4])],
        };
        transportA.sendSnapshotMessage(msg);

        for (const bytes of dcA._sent) {
          dcB._fire("message", { data: bytes.buffer });
        }

        expect(received).toHaveLength(1);
        expect(received[0]!.type).toBe(MessageType.SNAPSHOT_REQUEST);
        if (received[0]!.type === MessageType.SNAPSHOT_REQUEST) {
          expect(received[0]!.cids).toHaveLength(1);
          expect(received[0]!.cids[0]).toEqual(new Uint8Array([1, 2, 3, 4]));
        }

        transportA.destroy();
        transportB.destroy();
      },
    );

    it("snapshot messages do not fire onMessage", () => {
      const dcA = mockDataChannel();
      const dcB = mockDataChannel();
      const tA = createTransport(dcA);
      const tB = createTransport(dcB);

      const channelReceived: unknown[] = [];
      tB.onMessage((ch, msg) => channelReceived.push({ ch, msg }));
      const snapReceived: SnapshotMessage[] = [];
      tB.onSnapshotMessage((m) => snapReceived.push(m));

      tA.sendSnapshotMessage({
        type: MessageType.SNAPSHOT_CATALOG,
        entries: [],
        tip: null,
      });

      for (const bytes of dcA._sent) {
        dcB._fire("message", { data: bytes.buffer });
      }

      expect(channelReceived).toHaveLength(0);
      expect(snapReceived).toHaveLength(1);

      tA.destroy();
      tB.destroy();
    });

    it("channel messages do not fire onSnapshotMessage", () => {
      const dcA = mockDataChannel();
      const dcB = mockDataChannel();
      const tA = createTransport(dcA);
      const tB = createTransport(dcB);

      const snapReceived: SnapshotMessage[] = [];
      tB.onSnapshotMessage((m) => snapReceived.push(m));

      tA.send("notes", {
        type: MessageType.RECONCILE_START,
        channel: "notes",
        fingerprint: new Uint8Array(32),
        editCount: 0,
      });

      for (const bytes of dcA._sent) {
        dcB._fire("message", { data: bytes.buffer });
      }

      expect(snapReceived).toHaveLength(0);

      tA.destroy();
      tB.destroy();
    });

    it("send() throws on snapshot-typed message", () => {
      const dc = mockDataChannel();
      const t = createTransport(dc);
      expect(() =>
        t.send("notes", {
          type: MessageType.SNAPSHOT_CATALOG,
          entries: [],
          tip: null,
        }),
      ).toThrow(/sendSnapshotMessage/);
      t.destroy();
    });

    it("send() throws on empty channelName", () => {
      const dc = mockDataChannel();
      const t = createTransport(dc);
      expect(() =>
        t.send("", {
          type: MessageType.RECONCILE_START,
          channel: "",
          fingerprint: new Uint8Array(32),
          editCount: 0,
        }),
      ).toThrow(/non-empty/);
      t.destroy();
    });

    it("malformed: snapshot type in channel frame is dropped", () => {
      const dc = mockDataChannel();
      const t = createTransport(dc);

      const channelCb = vi.fn();
      const snapCb = vi.fn();
      t.onMessage(channelCb);
      t.onSnapshotMessage(snapCb);

      // Bypass the guard in send() by encoding directly
      const bad = encodeFrame("notes", {
        type: MessageType.SNAPSHOT_CATALOG,
        entries: [],
        tip: null,
      });
      dc._fire("message", { data: bad.buffer });

      expect(channelCb).not.toHaveBeenCalled();
      expect(snapCb).not.toHaveBeenCalled();
      t.destroy();
    });

    it("malformed: channel type in snapshot frame is dropped", () => {
      const dc = mockDataChannel();
      const t = createTransport(dc);

      const channelCb = vi.fn();
      const snapCb = vi.fn();
      t.onMessage(channelCb);
      t.onSnapshotMessage(snapCb);

      // Construct a frame with len=0 but a channel-typed
      // message body.
      const msgBytes = (() => {
        const frame = encodeFrame("x", {
          type: MessageType.RECONCILE_START,
          channel: "x",
          fingerprint: new Uint8Array(32),
          editCount: 0,
        });
        // Strip the "x" channel prefix: frame is
        // [0, 1, 'x', ...msgBytes]. Rebuild with len=0.
        return frame.subarray(3);
      })();
      const bad = new Uint8Array(2 + msgBytes.length);
      bad[0] = 0;
      bad[1] = 0;
      bad.set(msgBytes, 2);
      dc._fire("message", { data: bad.buffer });

      expect(channelCb).not.toHaveBeenCalled();
      expect(snapCb).not.toHaveBeenCalled();
      t.destroy();
    });
  });

  describe("createReconcileChannel", () => {
    it("creates data channel with correct label", () => {
      let createdLabel = "";
      let createdOptions: RTCDataChannelInit = {};

      const mockPC = {
        createDataChannel(label: string, options?: RTCDataChannelInit) {
          createdLabel = label;
          createdOptions = options ?? {};
          return mockDataChannel();
        },
      } as unknown as RTCPeerConnection;

      const dc = createReconcileChannel(mockPC);

      expect(createdLabel).toBe("pokapali-reconcile");
      expect(createdOptions.ordered).toBe(true);
      expect(dc).toBeTruthy();
    });
  });
});
