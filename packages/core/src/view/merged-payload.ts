/**
 * Re-export mergedPayloadView from @pokapali/document
 * for backwards compatibility.
 */
import type { Codec } from "@pokapali/codec";
import type { View } from "@pokapali/document";
import { State } from "@pokapali/document";

export function mergedPayloadView(codec: Codec): View<Uint8Array> {
  return State.view(codec);
}
