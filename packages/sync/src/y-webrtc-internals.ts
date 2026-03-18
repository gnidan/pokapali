/**
 * Safe accessor for y-webrtc internals that are exported
 * from the ESM source (src/y-webrtc.js) but omitted from
 * the CJS bundle (dist/y-webrtc.cjs) and the .d.ts.
 *
 * In the monorepo Vite resolves to the ESM source via the
 * `module` field, so bare `import { signalingConns }` works.
 * Published consumers may hit a bundler that falls back to
 * the CJS build, where these symbols are undefined.
 *
 * This module does a namespace import and validates the
 * symbols exist at runtime, giving a clear error instead of
 * `undefined is not a function`.
 */

import type { Observable } from "lib0/observable";
import * as yWebrtc from "y-webrtc";

const mod = yWebrtc as unknown as Record<string, unknown>;

if (typeof mod.signalingConns === "undefined") {
  throw new Error(
    "@pokapali/sync: y-webrtc resolved to a build that " +
      "does not export `signalingConns`. This usually " +
      "means your bundler used the CJS bundle instead " +
      "of the ESM source. Ensure your bundler supports " +
      "the `import` condition in package.json exports, " +
      "or configure an alias from `y-webrtc` to " +
      "`y-webrtc/src/y-webrtc.js`.",
  );
}

if (typeof mod.setupSignalingHandlers === "undefined") {
  throw new Error(
    "@pokapali/sync: y-webrtc resolved to a build that " +
      "does not export `setupSignalingHandlers`. See " +
      "the error above for resolution steps.",
  );
}

/**
 * Module-level map of signaling connections keyed by URL
 * (or adapter key). Shared across all WebrtcProvider
 * instances — our GossipSub adapter registers here so
 * rooms discover it during announcements.
 */
export const signalingConns = mod.signalingConns as Map<string, unknown>;

/**
 * Registers the standard connect/message/disconnect
 * handlers on a SignalingConn-like Observable. Extracted
 * from the SignalingConn constructor so adapters can
 * reuse the same handler logic.
 */
export const setupSignalingHandlers = mod.setupSignalingHandlers as (
  conn: Observable<string> & {
    url: string;
    send(message: unknown): void;
  },
) => void;
