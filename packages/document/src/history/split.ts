/**
 * Re-export for backwards compatibility.
 *
 * New code should use `Epoch.splitAtSnapshot`.
 */
import type { CID } from "multiformats/cid";
import type { Codec } from "@pokapali/codec";
import type { History } from "./history.js";
import { Epoch } from "./epoch.js";

/** @deprecated Use `Epoch.splitAtSnapshot`. */
export function splitEpochAtSnapshot(
  tree: History,
  position: number,
  snapshot: Uint8Array,
  cid: CID,
  codec: Codec,
): History {
  return Epoch.splitAtSnapshot(tree, position, snapshot, cid, codec);
}
