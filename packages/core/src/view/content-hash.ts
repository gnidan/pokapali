/**
 * Re-export contentHashView from @pokapali/document
 * for backwards compatibility.
 */
import type { View } from "@pokapali/document";
import { Fingerprint } from "@pokapali/document";

export function contentHashView(): View<Uint8Array> {
  return Fingerprint.view();
}
