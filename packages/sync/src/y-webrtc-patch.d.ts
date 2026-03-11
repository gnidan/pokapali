import type { Observable } from "lib0/observable";

declare module "y-webrtc" {
  /**
   * Module-level map of signaling connections keyed by
   * URL (or adapter key like "libp2p:gossipsub").
   */
  export const signalingConns: Map<string, SignalingConn>;

  /**
   * Registers the standard connect/message/disconnect
   * handlers on a SignalingConn-like Observable.
   * Extracted from the SignalingConn constructor so
   * adapters (e.g. GossipSub) can reuse the same
   * handler logic.
   */
  export function setupSignalingHandlers(
    conn: Observable<string> & {
      url: string;
      send(message: unknown): void;
    },
  ): void;
}
