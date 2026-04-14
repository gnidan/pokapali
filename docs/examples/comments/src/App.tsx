/**
 * App.tsx — Comments integration example.
 *
 * Demonstrates @pokapali/comments + @pokapali/comments-tiptap
 * with a Tiptap editor. Shows:
 *
 *   - Creating a comments instance on a channel
 *   - Wiring CommentHighlight + PendingAnchorHighlight
 *   - Creating anchored comments from selection
 *   - Rendering a sidebar with threaded comments
 *   - Resolving anchor positions for spatial ordering
 *   - Replying, resolving, and deleting comments
 *
 * This is a minimal but complete integration — a real
 * app would add styling, presence cursors, and richer
 * comment data.
 */

import { useState, useEffect, useCallback } from "react";
import type { Doc as YDoc } from "yjs";
import { pokapali, type Doc, statusLabel } from "@pokapali/core";
import { useFeed, useDocReady } from "@pokapali/react";
import { comments, type Comments, type Comment } from "@pokapali/comments";
import {
  anchorFromSelection,
  CommentHighlight,
  PendingAnchorHighlight,
  rebuildCommentDecorations,
  getSyncState,
  resolveAnchors,
} from "@pokapali/comments-tiptap";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";

// -- App-specific comment data shape --
// Extend this with whatever fields your app needs.
interface CommentData {
  status: "open" | "resolved";
}

// -- App initialization --
// Declare both "content" and "comments" channels.
const app = pokapali({
  appId: "comments-example",
  channels: ["content", "comments"],
  origin: window.location.origin,
});

export function App() {
  const [doc, setDoc] = useState<Doc | null>(null);

  useEffect(() => {
    const url = window.location.hash.slice(1);
    const promise = url ? app.open(url) : app.create();

    let destroyed = false;
    promise.then((d) => {
      if (destroyed) {
        d.destroy();
        return;
      }
      // Show the admin URL for sharing
      if (!url) {
        console.log("Admin URL:", d.urls.admin);
        console.log("Write URL:", d.urls.write);
        console.log("Read URL:", d.urls.read);
      }
      setDoc(d);
    });

    return () => {
      destroyed = true;
    };
  }, []);

  if (!doc) return <div>Loading...</div>;
  return <DocumentEditor doc={doc} />;
}

function DocumentEditor({ doc }: { doc: Doc }) {
  const ready = useDocReady(doc);
  const status = useFeed(doc.status);
  const [instance, setInstance] = useState<Comments<CommentData> | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  // -- Create Comments instance --
  useEffect(() => {
    const commentsDoc = doc.channel("comments").handle as YDoc;
    const contentDoc = doc.channel("content").handle as YDoc;

    // Note: Tiptap uses XmlFragment, not Text.
    // Pass the correct content type or anchors
    // won't resolve.
    const c = comments<CommentData>(commentsDoc, contentDoc, {
      author: doc.identityPubkey,
      clientIdMapping: doc.clientIdMapping,
      contentType: contentDoc.getXmlFragment("default"),
    });

    setInstance(c);
    return () => c.destroy();
  }, [doc]);

  // -- Set up the Tiptap editor --
  // Do NOT include activeId in deps — that would
  // destroy and recreate the editor on every click.
  // Instead, update the highlight extension via
  // rebuildCommentDecorations() in the effect below.
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ history: false }),
        Collaboration.configure({
          document: doc.channel("content").handle as YDoc,
        }),
        CommentHighlight.configure({
          commentsDoc: doc.channel("comments").handle as YDoc,
          contentDoc: doc.channel("content").handle as YDoc,
          activeCommentId: null,
        }),
        PendingAnchorHighlight,
      ],
      editable: doc.capability.channels.has("content"),
    },
    [doc],
  );

  // Rebuild comment highlights when active comment
  // changes. The CommentsSidebar handles rebuilds
  // when the comment list itself changes.
  useEffect(() => {
    if (editor?.view) {
      rebuildCommentDecorations(editor.view);
    }
  }, [editor?.view, activeId]);

  if (!ready) return <div>Connecting...</div>;

  return (
    <>
      <div className="status-bar">
        Status: {statusLabel(status)} | Role:{" "}
        {doc.capability.isAdmin
          ? "admin"
          : doc.capability.channels.has("content")
            ? "writer"
            : "reader"}
      </div>
      <div style={{ display: "flex", flex: 1 }}>
        <div className="editor-pane">
          <EditorContent editor={editor} />
        </div>
        {instance && editor && (
          <CommentsSidebar
            instance={instance}
            editor={editor}
            doc={doc}
            activeId={activeId}
            onSelect={setActiveId}
          />
        )}
      </div>
    </>
  );
}

// -- Comments sidebar --

function CommentsSidebar({
  instance,
  editor,
  doc,
  activeId,
  onSelect,
}: {
  instance: Comments<CommentData>;
  editor: ReturnType<typeof useEditor>;
  doc: Doc;
  activeId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const commentList = useFeed(instance.feed);
  const [input, setInput] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);

  // Rebuild editor highlights when comments change
  useEffect(() => {
    if (editor?.view) {
      rebuildCommentDecorations(editor.view);
    }
  }, [editor?.view, commentList]);

  // -- Create a new anchored comment --
  const handleAdd = useCallback(() => {
    if (!input.trim() || !editor) return;

    // Create anchor from current editor selection.
    // Returns null if nothing is selected.
    const anchor = replyTo
      ? undefined
      : (anchorFromSelection(editor) ?? undefined);

    instance.add({
      content: input.trim(),
      anchor,
      parentId: replyTo ?? undefined,
      data: { status: "open" },
    });

    setInput("");
    setReplyTo(null);
  }, [input, editor, instance, replyTo]);

  // -- Resolve anchor positions for ordering --
  // This maps comment IDs to editor positions so
  // we can sort comments by where they appear in
  // the document (spatial anchoring).
  const syncState = editor ? getSyncState(editor) : null;
  const resolved = editor
    ? resolveAnchors(
        doc.channel("comments").handle as YDoc,
        doc.channel("content").handle as YDoc,
        syncState,
      )
    : [];
  const posMap = new Map(resolved.map((r) => [r.id, r.from]));

  // Sort by document position (unanchored at end)
  const sorted = [...(commentList ?? [])].sort((a, b) => {
    const pa = posMap.get(a.id) ?? Infinity;
    const pb = posMap.get(b.id) ?? Infinity;
    return pa - pb;
  });

  return (
    <div className="sidebar">
      <h2>Comments</h2>

      <div className="add-comment">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAdd();
          }}
          placeholder={replyTo ? "Reply..." : "Select text, then comment..."}
        />
        <button onClick={handleAdd}>{replyTo ? "Reply" : "Add"}</button>
        {replyTo && <button onClick={() => setReplyTo(null)}>Cancel</button>}
      </div>

      {sorted.map((comment) => (
        <CommentCard
          key={comment.id}
          comment={comment}
          instance={instance}
          isActive={activeId === comment.id}
          onSelect={onSelect}
          onReply={(id) => setReplyTo(id)}
        />
      ))}

      {sorted.length === 0 && (
        <p style={{ color: "#888", fontSize: "0.9rem" }}>
          Select text in the editor and add a comment.
        </p>
      )}
    </div>
  );
}

// -- Single comment card with actions --

function CommentCard({
  comment,
  instance,
  isActive,
  onSelect,
  onReply,
}: {
  comment: Comment<CommentData>;
  instance: Comments<CommentData>;
  isActive: boolean;
  onSelect: (id: string | null) => void;
  onReply: (id: string) => void;
}) {
  const handleResolve = () => {
    try {
      const next = comment.data.status === "open" ? "resolved" : "open";
      instance.update(comment.id, {
        data: { status: next },
      });
    } catch {
      // Comment may have been deleted by a peer
    }
  };

  const handleDelete = () => {
    try {
      instance.delete(comment.id);
    } catch {
      // Already deleted
    }
  };

  const isResolved = comment.data.status === "resolved";

  return (
    <div
      className={`comment ${isActive ? "active" : ""}`}
      onClick={() => onSelect(isActive ? null : comment.id)}
      style={{ opacity: isResolved ? 0.6 : 1 }}
    >
      <div className="comment-meta">
        {comment.authorVerified ? comment.author.slice(0, 8) : "unverified"} ·{" "}
        {new Date(comment.ts).toLocaleTimeString()}
        {isResolved && " · resolved"}
      </div>
      <div>{comment.content}</div>
      <div className="comment-actions">
        <button onClick={handleResolve}>
          {isResolved ? "Reopen" : "Resolve"}
        </button>
        <button onClick={() => onReply(comment.id)}>Reply</button>
        <button onClick={handleDelete}>Delete</button>
      </div>

      {/* Replies (one level only) */}
      {comment.children.map((reply) => (
        <div key={reply.id} className="reply">
          <div className="comment-meta">
            {reply.authorVerified ? reply.author.slice(0, 8) : "unverified"} ·{" "}
            {new Date(reply.ts).toLocaleTimeString()}
          </div>
          <div>{reply.content}</div>
        </div>
      ))}
    </div>
  );
}
