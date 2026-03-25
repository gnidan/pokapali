/**
 * Re-export ViewFeed from @pokapali/document
 * for backwards compatibility.
 */
import type { Feed } from "../feed.js";
import type { View, Status, History } from "@pokapali/document";
import { Feed as DocumentFeed } from "@pokapali/document";

export interface ViewFeed<V> extends Feed<Status<V>> {
  update(tree: History): void;
  destroy(): void;
}

export function createViewFeed<V>(view: View<V>, tree: History): ViewFeed<V> {
  return DocumentFeed.create(view, tree);
}
