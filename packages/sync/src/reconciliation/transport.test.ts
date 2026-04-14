import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { MessageType, type Message } from "./messages.js";
import {
  createTransport,
  encodeFrame,
  decodeFrame,
  createReconcileChannel,
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
