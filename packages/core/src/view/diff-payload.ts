/**
 * Re-export diffPayloadView from @pokapali/document
 * for backwards compatibility.
 */
import type { Codec } from "@pokapali/codec";
import type { History } from "@pokapali/document";
import { diff } from "@pokapali/document";

/**
 * DerivedView is kept in core (not moved to document).
 */
export interface DiffPayloadDeps {
  before: Uint8Array;
  after: Uint8Array;
}

export function diffPayloadView(codec: Codec): {
  name: string;
  description: string;
  compute: (tree: History, deps: DiffPayloadDeps) => Uint8Array;
} {
  return {
    name: "diff-payload",
    description: "CRDT diff between merged payloads" + " at two positions",
    compute: (_tree, { before, after }) => diff(codec, before, after),
  };
}
