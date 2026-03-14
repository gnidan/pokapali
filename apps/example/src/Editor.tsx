import { useState, useEffect, useCallback, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import * as Y from "yjs";
import type { Doc as YDoc } from "yjs";
import type { Doc, VersionEntry } from "@pokapali/core";
import { createAutoSaver, docIdFromUrl } from "@pokapali/core";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — y-prosemirror has no type declarations
import {
  absolutePositionToRelativePosition,
  ySyncPluginKey,
} from "y-prosemirror";
import { StatusIndicator } from "./StatusIndicator";
import { SaveIndicator, LastUpdated } from "./SaveIndicator";
import { LockIcon, EncryptionInfo } from "./EncryptionInfo";
import { SharePanel } from "./SharePanel";
import { VersionHistory } from "./VersionHistory";
import { VersionPreviewOverlay } from "./VersionPreviewOverlay";
import { useVersionHistory } from "./useVersionHistory";
import { CommentSidebar } from "./CommentSidebar";
import { CommentPopover } from "./CommentPopover";
import { useComments } from "./useComments";
import type { Anchor } from "./pendingAnchorHighlight";
import {
  PendingAnchorHighlight,
  setPendingAnchorDecoration,
  clearPendingAnchorDecoration,
} from "./pendingAnchorHighlight";
import {
  CommentHighlight,
  rebuildCommentDecorations,
} from "./commentHighlight";
import { ConnectionStatus } from "./ConnectionStatus";
import { updateRecentTitle } from "./recentDocs";
import {
  loadUser,
  saveUser,
  renderCursor,
  type StoredUser,
} from "./UserIdentity";
import { capitalize } from "./utils";
import { useFeed } from "./useFeed";

export function EditorView({ doc, onBack }: { doc: Doc; onBack: () => void }) {
  const status = useFeed(doc.status);
  const saveState = useFeed(doc.saveState);
  const tipInfo = useFeed(doc.tip);
  const ackCount = tipInfo?.ackedBy.size ?? 0;

  const [showShare, setShowShare] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(
    null,
  );
  const [pendingAnchor, setPendingAnchor] = useState<Anchor | null>(null);
  const [previewVersion, setPreviewVersion] = useState<{
    entry: VersionEntry;
    ydoc: YDoc;
  } | null>(null);
  const [showEncryption, setShowEncryption] = useState(false);
  const [lastPublished, setLastPublished] = useState(Date.now());
  const [updateFlash, setUpdateFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [user, setUser] = useState<StoredUser>(loadUser);
  const [editingName, setEditingName] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const nameBtnRef = useRef<HTMLButtonElement>(null);
  const sharePanelRef = useRef<HTMLDivElement>(null);
  const metaDoc = doc.channel("_meta");
  const docMap = metaDoc.getMap("doc");
  const [docTitle, setDocTitle] = useState(
    () => (docMap.get("title") as string) || "Untitled",
  );
  const [editingTitle, setEditingTitle] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const titleBtnRef = useRef<HTMLButtonElement>(null);
  const [ready, setReady] = useState(false);

  // Preload version history on doc open so the
  // drawer opens instantly when the user clicks History.
  const versionHistory = useVersionHistory(doc);

  const {
    comments: commentList,
    addComment,
    addReply,
    resolveComment,
    reopenComment,
    deleteComment,
    commentsDoc,
  } = useComments(doc);

  const isReadOnly = !doc.capability.channels.has("content");
  const canSave = doc.capability.canPushSnapshots;
  const role = doc.role;

  const doSave = useCallback(() => {
    if (!canSave) return;
    doc.publish().catch(() => {});
  }, [doc, canSave]);

  // Ctrl+S / Cmd+S to publish
  useEffect(() => {
    if (!canSave) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        doSave();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canSave, doSave]);

  // Auto-save: beforeunload, visibilitychange,
  // debounced snapshot-recommended
  useEffect(() => {
    return createAutoSaver(doc);
  }, [doc]);

  useEffect(() => {
    const onSnapshotApplied = () => {
      setLastPublished(Date.now());
      setUpdateFlash(true);
      if (flashTimer.current) {
        clearTimeout(flashTimer.current);
      }
      flashTimer.current = setTimeout(() => setUpdateFlash(false), 2_000);
    };
    doc.on("snapshot", onSnapshotApplied);

    return () => {
      doc.off("snapshot", onSnapshotApplied);
      if (flashTimer.current) {
        clearTimeout(flashTimer.current);
      }
    };
  }, [doc]);

  // Wait for doc to be ready (snapshot loaded or
  // confirmed empty) before mounting Collaboration.
  // Fallback after 60s so readers aren't stuck on
  // "Loading…" forever if fetch never completes.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) setReady(true);
    }, 60_000);
    doc.ready().then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [doc]);

  const contentDoc = doc.channel("content");
  const shouldMount = ready || !isReadOnly;
  // Writers always show the editor — they don't need
  // to wait for a snapshot load. Readers wait for
  // ready (snapshot loaded) or synced (peer connected).
  const showEditor = !isReadOnly || ready || status === "synced";

  const editor = useEditor(
    {
      editable: !isReadOnly,
      extensions: shouldMount
        ? [
            StarterKit.configure({ history: false }),
            Collaboration.configure({
              document: contentDoc,
            }),
            CollaborationCursor.configure({
              provider: doc.provider,
              user: {
                name: user.name || "Anonymous",
                color: user.color,
              },
              render: renderCursor,
            }),
            CommentHighlight.configure({
              commentsDoc: commentsDoc ?? null,
              contentDoc,
              activeCommentId: selectedCommentId,
            }),
            PendingAnchorHighlight,
          ]
        : [StarterKit.configure({ history: false })],
    },
    [doc, shouldMount, commentsDoc],
  );

  const handlePopoverComment = useCallback(() => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;

    const syncState = ySyncPluginKey.getState(editor.state);
    if (!syncState?.mapping) return;

    const { type, mapping } = syncState;
    const startRel = absolutePositionToRelativePosition(from, type, mapping);
    const endRel = absolutePositionToRelativePosition(to, type, mapping);
    if (!startRel || !endRel) return;

    const anchor: Anchor = {
      start: Y.encodeRelativePosition(startRel),
      end: Y.encodeRelativePosition(endRel),
    };

    setPendingAnchor(anchor);
    setPendingAnchorDecoration(editor.view, anchor);
    setShowComments(true);
  }, [editor]);

  // Rebuild comment decorations when comments or
  // active selection change
  useEffect(() => {
    if (!editor?.view) return;
    editor.extensionManager.extensions.forEach((ext) => {
      if (ext.name === "commentHighlight") {
        ext.options.activeCommentId = selectedCommentId;
      }
    });
    rebuildCommentDecorations(editor.view);
  }, [editor, commentList, selectedCommentId]);

  useEffect(() => {
    const displayName = user.name || "Anonymous";
    doc.awareness.setLocalStateField("user", {
      name: displayName,
      color: user.color,
    });
    saveUser(user);
  }, [doc, user]);

  const commitName = useCallback(() => {
    setEditingName(false);
    // Return focus to name display button
    requestAnimationFrame(() => {
      nameBtnRef.current?.focus();
    });
  }, []);

  const handleNameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      (e.target as HTMLInputElement).blur();
    }
  }, []);

  // Sync title from _meta subdoc
  const docId = docIdFromUrl(doc.urls.best);
  useEffect(() => {
    const observer = () => {
      const t = (docMap.get("title") as string) || "Untitled";
      setDocTitle(t);
      if (t !== "Untitled") {
        updateRecentTitle(docId, t);
      }
    };
    docMap.observe(observer);
    observer();
    return () => docMap.unobserve(observer);
  }, [docMap, docId]);

  const commitTitle = useCallback(() => {
    setEditingTitle(false);
    const trimmed = docTitle.trim();
    if (trimmed && trimmed !== "Untitled") {
      docMap.set("title", trimmed);
    }
    requestAnimationFrame(() => {
      titleBtnRef.current?.focus();
    });
  }, [docMap, docTitle]);

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      (e.target as HTMLInputElement).blur();
    }
  }, []);

  useEffect(() => {
    if (editingName && nameRef.current) {
      nameRef.current.focus();
      nameRef.current.select();
    }
  }, [editingName]);

  useEffect(() => {
    if (editingTitle && titleRef.current) {
      titleRef.current.focus();
      titleRef.current.select();
    }
  }, [editingTitle]);

  const handleVersionPreview = useCallback(
    (entry: VersionEntry, ydoc: YDoc) => {
      setPreviewVersion({ entry, ydoc });
    },
    [],
  );

  const closePreview = useCallback(() => {
    setPreviewVersion(null);
  }, []);

  const handleAddComment = useCallback(
    (content: string) => {
      if (!pendingAnchor) return;
      addComment(content, pendingAnchor);
      setPendingAnchor(null);
      if (editor?.view) {
        clearPendingAnchorDecoration(editor.view);
      }
    },
    [editor, addComment, pendingAnchor],
  );

  const handleAddReply = useCallback(
    (parentId: string, content: string) => {
      addReply(parentId, content);
    },
    [addReply],
  );

  useEffect(() => {
    if (showShare && sharePanelRef.current) {
      sharePanelRef.current.focus();
    }
  }, [showShare]);

  // Must be last-declared effect: React runs
  // cleanups in declaration order, so all other
  // effect cleanups (listeners, observers, timers)
  // run while doc is still alive.
  useEffect(() => {
    return () => {
      doc.destroy();
    };
  }, [doc]);

  return (
    <div className="app">
      <div className="header">
        <button
          className="back-arrow"
          onClick={onBack}
          aria-label="Back to document list"
        >
          &#x2039;
        </button>
        <h1>Pokapali</h1>
        {!isReadOnly && editingTitle ? (
          <input
            ref={titleRef}
            className="doc-title-input"
            value={docTitle}
            placeholder="Untitled"
            aria-label="Document title"
            onChange={(e) => setDocTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={handleTitleKeyDown}
            maxLength={80}
          />
        ) : (
          <button
            ref={titleBtnRef}
            className={"doc-title" + (isReadOnly ? " read-only" : "")}
            onClick={isReadOnly ? undefined : () => setEditingTitle(true)}
            title={docTitle || "Untitled"}
            aria-label={`Document: ${docTitle || "Untitled"}`}
            disabled={isReadOnly}
          >
            {docTitle || "Untitled"}
          </button>
        )}
        <span className="encryption-wrap">
          <button
            className="encryption-btn"
            onClick={() => setShowEncryption((s) => !s)}
            aria-label="Encryption info"
            title="End-to-end encrypted"
          >
            <LockIcon size={14} />
          </button>
          {showEncryption && (
            <EncryptionInfo onClose={() => setShowEncryption(false)} />
          )}
        </span>
        <span className={`badge ${role}`}>{capitalize(role)}</span>
        {editingName ? (
          <input
            ref={nameRef}
            className="user-name-input"
            value={user.name}
            placeholder="Your name"
            aria-label="Your display name"
            onChange={(e) =>
              setUser((u) => ({
                ...u,
                name: e.target.value,
              }))
            }
            onBlur={commitName}
            onKeyDown={handleNameKeyDown}
            maxLength={30}
          />
        ) : (
          <button
            ref={nameBtnRef}
            className="user-name-display"
            onClick={() => setEditingName(true)}
            title="Click to change your name"
            aria-label={`Your name: ${user.name || "not set"}. Click to edit`}
            style={{ borderColor: user.color }}
          >
            {user.name || "Set name..."}
          </button>
        )}
        <StatusIndicator status={status} />
        {canSave ? (
          <SaveIndicator
            saveState={saveState}
            ackCount={ackCount}
            onPublish={doSave}
          />
        ) : (
          <LastUpdated timestamp={lastPublished} flash={updateFlash} />
        )}
        <button
          className="toggle-share"
          data-testid="share-toggle"
          onClick={() => setShowShare((s) => !s)}
          aria-expanded={showShare}
          aria-label={showShare ? "Hide share panel" : "Open share panel"}
        >
          {showShare ? "Hide share" : "Share"}
        </button>
        <button
          className="toggle-history"
          onClick={() => setShowHistory((s) => !s)}
          aria-expanded={showHistory}
          aria-label={
            showHistory ? "Hide version history" : "Open version history"
          }
        >
          {showHistory ? "Hide history" : "History"}
        </button>
        <button
          className="toggle-comments"
          onClick={() => setShowComments((s) => !s)}
          aria-expanded={showComments}
          aria-label={showComments ? "Hide comments" : "Open comments"}
        >
          {showComments ? "Hide comments" : "Comments"}
          {commentList.length > 0 && (
            <span className="comment-count-badge">{commentList.length}</span>
          )}
        </button>
      </div>

      {showShare && <SharePanel ref={sharePanelRef} doc={doc} />}

      <div className="editor-area">
        <div
          className="editor-container"
          style={previewVersion ? { visibility: "hidden" } : undefined}
        >
          {showEditor ? (
            <>
              {isReadOnly && (
                <div className="read-only-banner">
                  Read-only — you cannot edit this document.
                </div>
              )}
              <EditorContent editor={editor} />
            </>
          ) : (
            <div className="loading-doc">Loading…</div>
          )}
        </div>

        {!isReadOnly && !pendingAnchor && (
          <CommentPopover onComment={handlePopoverComment} />
        )}

        {previewVersion && (
          <VersionPreviewOverlay
            doc={doc}
            liveEditor={editor}
            entry={previewVersion.entry}
            ydoc={previewVersion.ydoc}
            onClose={closePreview}
          />
        )}

        {showHistory && (
          <VersionHistory
            doc={doc}
            history={versionHistory}
            onClose={() => setShowHistory(false)}
            onPreview={handleVersionPreview}
            onClosePreview={closePreview}
          />
        )}

        {showComments && (
          <CommentSidebar
            comments={commentList}
            myPubkey={doc.identityPubkey}
            hasPendingAnchor={pendingAnchor != null}
            onAddComment={handleAddComment}
            onAddReply={handleAddReply}
            onResolve={resolveComment}
            onReopen={reopenComment}
            onDelete={deleteComment}
            onClose={() => {
              setShowComments(false);
              setSelectedCommentId(null);
              if (pendingAnchor) {
                setPendingAnchor(null);
                if (editor?.view) {
                  clearPendingAnchorDecoration(editor.view);
                }
              }
            }}
            selectedId={selectedCommentId}
            onSelect={setSelectedCommentId}
          />
        )}
      </div>

      <ConnectionStatus doc={doc} />
    </div>
  );
}
