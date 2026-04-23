/**
 * Mock RTCPeerConnection pair for Node integration
 * tests. Cross-wires two fake data channels so
 * PeerSync.wirePeerConnection() works without WebRTC.
 *
 * Usage:
 *   const [pcA, pcB] = createMockPeerPair();
 *   alicePeerSync.wirePeerConnection(pcA, true);
 *   bobPeerSync.wirePeerConnection(pcB, false);
 *
 * The initiator (pcA) creates the data channel via
 * createDataChannel(). The responder (pcB) receives
 * it via the "datachannel" event. Messages sent on
 * one side are delivered asynchronously to the other.
 *
 * @module
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

interface MockDataChannel {
  label: string;
  readyState: RTCDataChannelState;
  binaryType: string;
  ordered: boolean;
  _listeners: Map<string, Set<AnyFn>>;
  _peer: MockDataChannel | null;
  addEventListener(event: string, cb: AnyFn): void;
  removeEventListener(event: string, cb: AnyFn): void;
  send(data: ArrayBuffer | Uint8Array): void;
  close(): void;
}

function createMockDataChannelPair(
  label: string,
  opts?: RTCDataChannelInit,
): [MockDataChannel, MockDataChannel] {
  function makeDC(): MockDataChannel {
    const listeners = new Map<string, Set<AnyFn>>();
    const dc: MockDataChannel = {
      label,
      readyState: "connecting" as RTCDataChannelState,
      binaryType: "arraybuffer",
      ordered: opts?.ordered ?? true,
      _listeners: listeners,
      _peer: null,

      addEventListener(event: string, cb: AnyFn) {
        if (!listeners.has(event)) {
          listeners.set(event, new Set());
        }
        listeners.get(event)!.add(cb);
      },

      removeEventListener(event: string, cb: AnyFn) {
        listeners.get(event)?.delete(cb);
      },

      send(data: ArrayBuffer | Uint8Array) {
        if (dc.readyState !== "open") {
          throw new Error(
            `MockDataChannel: cannot send ` + `in state "${dc.readyState}"`,
          );
        }
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        // Deliver to peer asynchronously (simulates
        // the wire delay that real WebRTC has).
        const peer = dc._peer;
        if (peer && peer.readyState === "open") {
          queueMicrotask(() => {
            fire(peer, "message", {
              data: bytes.buffer,
            });
          });
        }
      },

      close() {
        dc.readyState = "closed";
        fire(dc, "close", {});
        if (dc._peer && dc._peer.readyState === "open") {
          dc._peer.readyState = "closed";
          fire(dc._peer, "close", {});
        }
      },
    };
    return dc;
  }

  const a = makeDC();
  const b = makeDC();
  a._peer = b;
  b._peer = a;
  return [a, b];
}

function fire(
  dc: MockDataChannel,
  event: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any,
): void {
  for (const cb of dc._listeners.get(event) ?? []) {
    cb(data);
  }
}

/**
 * Open both sides of a data channel pair. Fires
 * the "open" event on each side asynchronously.
 */
function openPair(a: MockDataChannel, b: MockDataChannel): void {
  a.readyState = "open";
  b.readyState = "open";
  // Fire open events in next microtask so listeners
  // registered synchronously after wirePeerConnection
  // can catch them.
  queueMicrotask(() => {
    fire(a, "open", {});
    fire(b, "open", {});
  });
}

// ── Mock RTCPeerConnection ──────────────────────

interface MockPeerConnection {
  _listeners: Map<string, Set<AnyFn>>;
  _pendingChannels: MockDataChannel[];
  addEventListener(event: string, cb: AnyFn): void;
  removeEventListener(event: string, cb: AnyFn): void;
  createDataChannel(label: string, opts?: RTCDataChannelInit): MockDataChannel;
}

/**
 * Creates a cross-wired pair of mock
 * RTCPeerConnections suitable for passing to
 * PeerSync.wirePeerConnection().
 *
 * The first element is the initiator (creates DCs),
 * the second is the responder (receives DCs via
 * the "datachannel" event).
 *
 * Data channels open automatically after a
 * microtask delay.
 */
export function createMockPeerPair(): [
  MockPeerConnection & RTCPeerConnection,
  MockPeerConnection & RTCPeerConnection,
] {
  function makePC(): MockPeerConnection {
    const listeners = new Map<string, Set<AnyFn>>();
    return {
      _listeners: listeners,
      _pendingChannels: [],

      addEventListener(event: string, cb: AnyFn) {
        if (!listeners.has(event)) {
          listeners.set(event, new Set());
        }
        listeners.get(event)!.add(cb);
      },

      removeEventListener(event: string, cb: AnyFn) {
        listeners.get(event)?.delete(cb);
      },

      createDataChannel(
        label: string,
        opts?: RTCDataChannelInit,
      ): MockDataChannel {
        const [initiatorDC, responderDC] = createMockDataChannelPair(
          label,
          opts,
        );

        // Queue: deliver "datachannel" to
        // responder after a microtask so both
        // sides can register listeners first.
        this._pendingChannels.push(initiatorDC);

        queueMicrotask(() => {
          // Fire "datachannel" on the responder
          // peer connection with the responder's
          // data channel.
          firePC(responderPC, "datachannel", {
            channel: responderDC,
          });

          // Open both channels after another
          // microtask so the transport's
          // "open" handler fires after
          // wireDataChannel has registered
          // its listeners.
          queueMicrotask(() => {
            openPair(initiatorDC, responderDC);
          });
        });

        return initiatorDC;
      },
    };
  }

  const initiatorPC = makePC();
  const responderPC = makePC();

  return [
    initiatorPC as MockPeerConnection & RTCPeerConnection,
    responderPC as MockPeerConnection & RTCPeerConnection,
  ];
}

function firePC(
  pc: MockPeerConnection,
  event: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any,
): void {
  for (const cb of pc._listeners.get(event) ?? []) {
    cb(data);
  }
}

/**
 * Wire two PeerSync instances together via mock
 * RTCPeerConnections.
 *
 * Returns a cleanup function that closes the data
 * channels.
 */
export function connectTransports(
  alice: {
    wirePeerConnection: (pc: RTCPeerConnection, initiator: boolean) => void;
  },
  bob: {
    wirePeerConnection: (pc: RTCPeerConnection, initiator: boolean) => void;
  },
): { close: () => void } {
  const [pcA, pcB] = createMockPeerPair();

  alice.wirePeerConnection(pcA, true);
  bob.wirePeerConnection(pcB, false);

  return {
    close() {
      // Close all pending data channels
      for (const dc of pcA._pendingChannels) {
        if (dc.readyState === "open") dc.close();
      }
    },
  };
}
