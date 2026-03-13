/**
 * Y.Map storage helpers for comments.
 * Each comment is a Y.Map inside the top-level
 * "comments" Y.Map, keyed by comment ID.
 */

import * as Y from "yjs";
import type { Anchor } from "./anchor.js";

export interface StoredComment<T> {
  id: string;
  author: string;
  content: string;
  ts: number;
  anchorStart: Uint8Array | null;
  anchorEnd: Uint8Array | null;
  parentId: string | null;
  data: T;
}

/** Get the top-level comments Y.Map from the doc. */
export function commentsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap("comments") as Y.Map<Y.Map<unknown>>;
}

/** Read a single comment from a Y.Map entry. */
export function readComment<T>(entry: Y.Map<unknown>): StoredComment<T> {
  return {
    id: entry.get("id") as string,
    author: entry.get("author") as string,
    content: entry.get("content") as string,
    ts: entry.get("ts") as number,
    anchorStart: entry.get("anchorStart") as Uint8Array | null,
    anchorEnd: entry.get("anchorEnd") as Uint8Array | null,
    parentId: entry.get("parentId") as string | null,
    data: entry.get("data") as T,
  };
}

/** Write a new comment into the Y.Map. */
export function writeComment<T>(
  map: Y.Map<Y.Map<unknown>>,
  id: string,
  author: string,
  content: string,
  anchor: Anchor | undefined,
  parentId: string | undefined,
  data: T,
): void {
  const entry = new Y.Map<unknown>();
  entry.set("id", id);
  entry.set("author", author);
  entry.set("content", content);
  entry.set("ts", Date.now());
  entry.set("anchorStart", anchor ? anchor.start : null);
  entry.set("anchorEnd", anchor ? anchor.end : null);
  entry.set("parentId", parentId ?? null);
  entry.set("data", data);
  map.set(id, entry);
}

/** Update app-defined data fields on a comment. */
export function updateCommentData<T>(
  map: Y.Map<Y.Map<unknown>>,
  id: string,
  partial: Partial<T>,
): void {
  const entry = map.get(id);
  if (!entry) {
    throw new Error(`Comment "${id}" not found`);
  }
  const existing = entry.get("data") as T;
  entry.set("data", { ...existing, ...partial });
}

/** Hard-delete a comment (remove Y.Map entry). */
export function deleteComment(map: Y.Map<Y.Map<unknown>>, id: string): void {
  // No-op if not found (idempotent).
  map.delete(id);
}
