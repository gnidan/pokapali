/**
 * Hook that wires @pokapali/comments to a Doc and
 * provides reactive comment data + actions.
 *
 * Passes the real content doc with an XmlFragment
 * contentType so anchors resolve correctly against
 * Tiptap's ProseMirror document structure.
 */

import { useState, useEffect, useCallback } from "react";
import * as Y from "yjs";
import type { Doc } from "@pokapali/core";
import {
  comments,
  type Comments,
  type Comment,
  type Anchor,
} from "@pokapali/comments";
import { useFeed } from "@pokapali/react";

// ── App-defined comment data ─────────────────────

export interface CommentData {
  status: "open" | "resolved";
}

// ── Main hook ────────────────────────────────────

export function useComments(doc: Doc) {
  const [instance, setInstance] = useState<Comments<CommentData> | null>(null);
  const [commentsYDoc, setCommentsYDoc] = useState<Y.Doc | null>(null);

  useEffect(() => {
    let commentsDoc: Y.Doc;
    try {
      commentsDoc = doc.channel("comments");
    } catch {
      // Old docs created before comments channel
      // existed — comments are unavailable.
      return;
    }
    const contentDoc = doc.channel("content");

    const c = comments<CommentData>(commentsDoc, contentDoc, {
      author: doc.identityPubkey,
      clientIdMapping: doc.clientIdMapping,
      contentType: contentDoc.getXmlFragment("default"),
    });

    setInstance(c);
    setCommentsYDoc(commentsDoc);

    return () => {
      c.destroy();
      setCommentsYDoc(null);
    };
  }, [doc]);

  const emptyFeed = {
    getSnapshot: (): Comment<CommentData>[] => [],
    subscribe: () => () => {},
  };
  const commentList: Comment<CommentData>[] = useFeed(
    instance?.feed ?? emptyFeed,
  );

  const addComment = useCallback(
    (content: string, anchor?: Anchor): string | null => {
      if (!instance) return null;
      return instance.add({
        content,
        anchor,
        data: { status: "open" },
      });
    },
    [instance],
  );

  const addReply = useCallback(
    (parentId: string, content: string): string | null => {
      if (!instance) return null;
      return instance.add({
        content,
        parentId,
        data: { status: "open" },
      });
    },
    [instance],
  );

  const resolveComment = useCallback(
    (id: string) => {
      try {
        instance?.update(id, {
          data: { status: "resolved" },
        });
      } catch {
        // Comment may have been deleted by a peer
      }
    },
    [instance],
  );

  const reopenComment = useCallback(
    (id: string) => {
      try {
        instance?.update(id, {
          data: { status: "open" },
        });
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
    resolveComment,
    reopenComment,
    deleteComment,
    /** Raw comments doc for anchor resolution. */
    commentsDoc: commentsYDoc,
  };
}
