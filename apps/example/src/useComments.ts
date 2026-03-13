/**
 * Hook that wires @pokapali/comments to a Doc and
 * provides reactive comment data + actions.
 *
 * Handles the XmlFragment↔Text adapter gap: creates
 * anchors on XmlFragment (Tiptap) but passes them
 * through the comments package which stores them
 * as raw Uint8Array. Anchor resolution is handled
 * separately by commentHighlight.ts.
 */

import { useState, useEffect, useCallback } from "react";
import * as Y from "yjs";
import type { Editor } from "@tiptap/core";
import type { Doc } from "@pokapali/core";
import {
  comments,
  type Comments,
  type Comment,
  type Anchor,
} from "@pokapali/comments";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — y-prosemirror has no type declarations
import {
  absolutePositionToRelativePosition,
  ySyncPluginKey,
} from "y-prosemirror";
import { useFeed } from "./useFeed";

// ── App-defined comment data ─────────────────────

export interface CommentData {
  status: "open" | "resolved";
}

// ── Anchor creation adapter ──────────────────────

/**
 * Create an Anchor from ProseMirror selection
 * positions. Uses y-prosemirror to map PM positions
 * to Y.RelativePositions on the XmlFragment.
 *
 * The resulting Anchor bytes reference XmlFragment
 * items, NOT Y.Text — the comments package stores
 * them as-is but can't resolve them (see
 * commentHighlight.ts for resolution).
 */
export function createAnchorFromSelection(
  editor: Editor,
  from: number,
  to: number,
): Anchor | null {
  const syncState = ySyncPluginKey.getState(editor.state);
  if (!syncState) return null;

  const { type, mapping } = syncState;
  const startRelPos = absolutePositionToRelativePosition(from, type, mapping);
  const endRelPos = absolutePositionToRelativePosition(to, type, mapping);

  if (!startRelPos || !endRelPos) return null;

  return {
    start: Y.encodeRelativePosition(startRelPos),
    end: Y.encodeRelativePosition(endRelPos),
  };
}

function tryChannel(doc: Doc, name: string): Y.Doc | null {
  try {
    return doc.channel(name);
  } catch {
    return null;
  }
}

// ── Main hook ────────────────────────────────────

export function useComments(doc: Doc) {
  const [instance, setInstance] = useState<Comments<CommentData> | null>(null);

  useEffect(() => {
    let commentsDoc: Y.Doc;
    try {
      commentsDoc = doc.channel("comments");
    } catch {
      // Old docs created before comments channel
      // existed — comments are unavailable.
      return;
    }
    // Pass a dummy Y.Doc as contentDoc to avoid a Yjs
    // type conflict: @pokapali/comments calls
    // getText("default") but Tiptap already registered
    // getXmlFragment("default") on the real content doc.
    // Anchor resolution is handled by commentHighlight.ts
    // via y-prosemirror, so the package's Text-based
    // resolution (which returns "pending") is unused.
    const contentStub = new Y.Doc();

    const c = comments<CommentData>(commentsDoc, contentStub, {
      author: doc.identityPubkey,
      clientIdMapping: doc.clientIdMapping,
    });

    setInstance(c);

    return () => {
      c.destroy();
      contentStub.destroy();
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
      instance?.update(id, {
        data: { status: "resolved" },
      });
    },
    [instance],
  );

  const reopenComment = useCallback(
    (id: string) => {
      instance?.update(id, {
        data: { status: "open" },
      });
    },
    [instance],
  );

  const deleteComment = useCallback(
    (id: string) => {
      instance?.delete(id);
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
    commentsDoc: instance ? tryChannel(doc, "comments") : null,
  };
}
