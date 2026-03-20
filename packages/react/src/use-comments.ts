/**
 * Hook that wires @pokapali/comments to a Doc and
 * provides reactive comment data + actions.
 *
 * Generic over the app-defined comment data shape T.
 * Passes the real content doc with an XmlFragment
 * contentType so anchors resolve correctly against
 * Tiptap's ProseMirror document structure.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import type { AbstractType } from "yjs";
import type { Doc } from "@pokapali/core";
import {
  comments,
  type Comments,
  type Comment,
  type Anchor,
} from "@pokapali/comments";

import { useFeed } from "./use-feed.js";

// ── Default comment data ────────────────────────

/**
 * Default comment data shape with open/resolved
 * status. Used by CommentSidebar for filtering.
 */
export interface CommentData {
  status: "open" | "resolved";
}

// ── Helpers ─────────────────────────────────────

function tryChannel(doc: Doc, name: string): ReturnType<Doc["channel"]> | null {
  try {
    return doc.channel(name);
  } catch {
    // Old docs created before this channel existed.
    return null;
  }
}

// ── Options ─────────────────────────────────────

export interface UseCommentsOptions {
  /**
   * Yjs content type for anchor resolution.
   * Defaults to `contentDoc.getXmlFragment("default")`
   * which matches Tiptap's default structure.
   */
  contentType?: AbstractType<unknown>;
}

// ── Main hook ───────────────────────────────────

export function useComments<T>(doc: Doc, options?: UseCommentsOptions) {
  const commentsDoc = useMemo(() => tryChannel(doc, "comments"), [doc]);
  const contentDoc = useMemo(() => doc.channel("content"), [doc]);

  const [instance, setInstance] = useState<Comments<T> | null>(null);

  useEffect(() => {
    if (!commentsDoc || !contentDoc) return;

    const ct = options?.contentType ?? contentDoc.getXmlFragment("default");

    const c = comments<T>(commentsDoc, contentDoc, {
      author: doc.identityPubkey,
      clientIdMapping: doc.clientIdMapping,
      contentType: ct,
    });

    setInstance(c);

    return () => {
      c.destroy();
      setInstance(null);
    };
  }, [doc, commentsDoc, contentDoc, options?.contentType]);

  const emptyFeed = {
    getSnapshot: (): Comment<T>[] => [],
    subscribe: () => () => {},
  };
  const commentList: Comment<T>[] = useFeed(instance?.feed ?? emptyFeed);

  const addComment = useCallback(
    (content: string, data: T, anchor?: Anchor): string | null => {
      if (!instance) return null;
      return instance.add({ content, anchor, data });
    },
    [instance],
  );

  const addReply = useCallback(
    (parentId: string, content: string, data: T): string | null => {
      if (!instance) return null;
      return instance.add({ content, parentId, data });
    },
    [instance],
  );

  const updateComment = useCallback(
    (id: string, update: { data: Partial<T> }) => {
      try {
        instance?.update(id, update);
      } catch {
        // Comment may have been deleted by a peer
      }
    },
    [instance],
  );

  const deleteComment = useCallback(
    (id: string) => {
      try {
        instance?.delete(id);
      } catch {
        // Comment may have already been deleted
      }
    },
    [instance],
  );

  return {
    comments: commentList,
    addComment,
    addReply,
    updateComment,
    deleteComment,
    /** Raw comments doc for anchor resolution. */
    commentsDoc,
  };
}
