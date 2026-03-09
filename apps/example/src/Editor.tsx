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
import { SharePanel } from "./SharePanel";
import { ConnectionStatus } from "./ConnectionStatus";
import { updateRecentTitle } from "./recentDocs";

const CURSOR_COLORS = [
  "#f44336", "#2196f3", "#4caf50", "#ff9800",
  "#9c27b0", "#00bcd4", "#e91e63", "#8bc34a",
];

const STORAGE_KEY = "pokapali:user";

interface StoredUser {
  name: string;
  color: string;
}

function loadUser(): StoredUser {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.name && parsed.color) return parsed;
    }
  } catch {}
  const color = CURSOR_COLORS[
    Math.floor(Math.random() * CURSOR_COLORS.length)
  ];
  return { name: "", color };
}

function saveUser(user: StoredUser) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(user),
    );
  } catch {}
}

function renderCursor(user: { name: string; color: string }) {
  const el = document.createElement("span");
  el.classList.add("collab-cursor");
  el.style.borderColor = user.color;

  const label = document.createElement("span");
  label.classList.add("collab-cursor-label");
  label.style.background = user.color;
  label.textContent = user.name;
  el.appendChild(label);

  return el;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function LockIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function EncryptionInfo({
  onClose,
}: {
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        ref.current &&
        !ref.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () =>
      document.removeEventListener(
        "mousedown",
        handler,
      );
  }, [onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () =>
      document.removeEventListener(
        "keydown",
        handler,
      );
  }, [onClose]);

  return (
    <div ref={ref} className="encryption-popover">
      <div className="encryption-header">
        <LockIcon size={16} />
        End-to-end encrypted
      </div>
      <p>
        Relay and pinner nodes cannot read your
        content — they only store encrypted blocks.
      </p>
      <p>
        Only people with the document link can
        read it. Your link determines your access
        level: admin, writer, or reader.
      </p>
      <button
        className="encryption-close"
        onClick={onClose}
        aria-label="Close"
      >
        &#x2715;
      </button>
    </div>
  );
}

const SAVE_LABELS: Record<SaveState, string> = {
  saved: "Published",
  dirty: "Unpublished changes",
  saving: "Saving\u2026",
  unpublished: "Unpublished",
};

function saveLabel(
  saveState: SaveState,
  ackCount: number,
): string {
  if (saveState === "saved" && ackCount > 0) {
    return `Saved to ${ackCount} ${ackCount === 1 ? "pinner" : "pinners"}`;
  }
  return SAVE_LABELS[saveState];
}

function SaveIndicator({
  saveState,
  ackCount,
  onPublish,
}: {
  saveState: SaveState;
  ackCount: number;
  onPublish: () => void;
}) {
  return (
    <div
      className="save-indicator"
      role="status"
      aria-live="polite"
    >
      <span className={`save-state ${saveState}`}>
        {saveLabel(saveState, ackCount)}
      </span>
      {(saveState === "dirty" ||
        saveState === "unpublished") && (
        <button
          className="publish-now"
          onClick={onPublish}
          aria-label="Publish snapshot now"
        >
          Publish now
        </button>
      )}
    </div>
  );
}

function formatAgo(timestamp: number): string {
  const ago = Math.max(
    0,
    Math.round((Date.now() - timestamp) / 1000),
  );
  if (ago < 5) return "just now";
  if (ago < 60) return `${ago}s ago`;
  return `${Math.round(ago / 60)}m ago`;
}

function LastUpdated({
  timestamp,
  flash,
}: {
  timestamp: number;
  flash: boolean;
}) {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const id = setInterval(
      () => forceUpdate((n) => n + 1),
      5_000,
    );
    return () => clearInterval(id);
  }, []);

  return (
    <span
      className={
        "last-updated" + (flash ? " flashing" : "")
      }
      aria-live="polite"
    >
      Last updated: {formatAgo(timestamp)}
    </span>
  );
}

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

