import {
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import type {
  CollabDoc,
  DocStatus,
  SaveState,
} from "@pokapali/core";
import {
  createAutoSaver,
  docIdFromUrl,
} from "@pokapali/core";
import { StatusIndicator } from "./StatusIndicator";
import { SaveIndicator, LastUpdated } from "./SaveIndicator";
import {
  LockIcon,
  EncryptionInfo,
} from "./EncryptionInfo";
import { SharePanel } from "./SharePanel";
import { ConnectionStatus } from "./ConnectionStatus";
import { updateRecentTitle } from "./recentDocs";
import {
  loadUser,
  saveUser,
  renderCursor,
  type StoredUser,
} from "./UserIdentity";
import { capitalize } from "./utils";

export function EditorView({
  doc,
  onBack,
}: {
  doc: CollabDoc;
  onBack: () => void;
}) {
  const [status, setStatus] = useState<DocStatus>(
    doc.status,
  );
  const [showShare, setShowShare] = useState(false);
  const [showEncryption, setShowEncryption] =
    useState(false);
  const [saveState, setSaveState] = useState<SaveState>(
    doc.saveState,
  );
  const [ackCount, setAckCount] = useState(
    doc.ackedBy.size,
  );
  const [lastPublished, setLastPublished] = useState(
    Date.now(),
  );
  const [updateFlash, setUpdateFlash] = useState(false);
  const flashTimer = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const [user, setUser] = useState<StoredUser>(loadUser);
  const [editingName, setEditingName] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const nameBtnRef = useRef<HTMLButtonElement>(null);
  const sharePanelRef = useRef<HTMLDivElement>(null);
  const metaDoc = doc.subdoc("_meta");
  const docMap = metaDoc.getMap("doc");
  const [docTitle, setDocTitle] = useState(
    () =>
      (docMap.get("title") as string) || "Untitled",
  );
  const [editingTitle, setEditingTitle] =
    useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const titleBtnRef = useRef<HTMLButtonElement>(null);
  const [ready, setReady] = useState(false);

  const isReadOnly =
    !doc.capability.namespaces.has("content");
  const canSave = doc.capability.canPushSnapshots;
  const role = doc.role;

  const doSave = useCallback(() => {
    if (!canSave) return;
    doc.pushSnapshot().catch(() => {});
  }, [doc, canSave]);

  // Auto-save: beforeunload, visibilitychange,
  // debounced snapshot-recommended
  useEffect(() => {
    return createAutoSaver(doc);
  }, [doc]);

  useEffect(() => {
    const onStatus = (s: DocStatus) => setStatus(s);
    // Re-read live status on awareness activity so the
    // indicator reacts even if a y-webrtc status event
    // was missed (e.g. silent reconnect).
    const refreshStatus = () => setStatus(doc.status);
    const onSaveState = (s: SaveState) =>
      setSaveState(s);
    const onSnapshotApplied = () => {
      setLastPublished(Date.now());
      setUpdateFlash(true);
      if (flashTimer.current) {
        clearTimeout(flashTimer.current);
      }
      flashTimer.current = setTimeout(
        () => setUpdateFlash(false),
        2_000,
      );
      refreshStatus();
    };
    const onAck = () => {
      setAckCount(doc.ackedBy.size);
      refreshStatus();
    };
    doc.on("status", onStatus);
    doc.on("save-state", onSaveState);
    doc.on("snapshot-applied", onSnapshotApplied);
    doc.on("ack", onAck);
    const awareness = doc.awareness;
    awareness.on("change", refreshStatus);

    // Catch any transition between the initial
    // useState and this subscription.
    refreshStatus();
    setSaveState(doc.saveState);

    return () => {
      doc.off("status", onStatus);
      doc.off("save-state", onSaveState);
      doc.off("snapshot-applied", onSnapshotApplied);
      doc.off("ack", onAck);
      awareness.off("change", refreshStatus);
      if (flashTimer.current) {
        clearTimeout(flashTimer.current);
      }
      doc.destroy();
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
    doc.whenReady().then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [doc]);

  const contentDoc = doc.subdoc("content");
  const shouldMount = ready || !isReadOnly;
  // Writers always show the editor — they don't need
  // to wait for a snapshot load. Readers wait for
  // ready (snapshot loaded) or synced (peer connected).
  const showEditor =
    !isReadOnly || ready || status === "synced";

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
          ]
        : [StarterKit.configure({ history: false })],
    },
    [doc, shouldMount],
  );

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

  const handleNameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        (e.target as HTMLInputElement).blur();
      }
    },
    [],
  );

  // Sync title from _meta subdoc
  const docId = docIdFromUrl(doc.bestUrl);
  useEffect(() => {
    const observer = () => {
      const t =
        (docMap.get("title") as string) ||
        "Untitled";
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

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        (e.target as HTMLInputElement).blur();
      }
    },
    [],
  );

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

  useEffect(() => {
    if (showShare && sharePanelRef.current) {
      sharePanelRef.current.focus();
    }
  }, [showShare]);

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
            onChange={(e) =>
              setDocTitle(e.target.value)
            }
            onBlur={commitTitle}
            onKeyDown={handleTitleKeyDown}
            maxLength={80}
          />
        ) : (
          <button
            ref={titleBtnRef}
            className={
              "doc-title" +
              (isReadOnly ? " read-only" : "")
            }
            onClick={
              isReadOnly
                ? undefined
                : () => setEditingTitle(true)
            }
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
            onClick={() =>
              setShowEncryption((s) => !s)
            }
            aria-label="Encryption info"
            title="End-to-end encrypted"
          >
            <LockIcon size={14} />
          </button>
          {showEncryption && (
            <EncryptionInfo
              onClose={() =>
                setShowEncryption(false)
              }
            />
          )}
        </span>
        <span className={`badge ${role}`}>
          {capitalize(role)}
        </span>
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
          <LastUpdated
            timestamp={lastPublished}
            flash={updateFlash}
          />
        )}
        <button
          className="toggle-share"
          onClick={() => setShowShare((s) => !s)}
          aria-expanded={showShare}
          aria-label={
            showShare
              ? "Hide share panel"
              : "Open share panel"
          }
        >
          {showShare ? "Hide share" : "Share"}
        </button>
      </div>

      {showShare && (
        <SharePanel
          ref={sharePanelRef}
          doc={doc}
        />
      )}

      <div className="editor-container">
        {showEditor ? (
          <>
            {isReadOnly && (
              <div className="read-only-banner">
                Read-only — you cannot edit
                this document.
              </div>
            )}
            <EditorContent editor={editor} />
          </>
        ) : (
          <div className="loading-doc">
            Loading…
          </div>
        )}
      </div>

      <ConnectionStatus doc={doc} />
    </div>
  );
}
