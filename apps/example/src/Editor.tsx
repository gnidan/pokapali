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
import type { CollabDoc, DocStatus } from "@pokapali/core";
import { createAutoSaver } from "@pokapali/core";
import { StatusIndicator } from "./StatusIndicator";
import { SharePanel } from "./SharePanel";
import { ConnectionStatus } from "./ConnectionStatus";

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

type SaveState =
  | "published"
  | "unpublished"
  | "saving";

const SAVE_LABELS: Record<SaveState, string> = {
  published: "Published",
  unpublished: "Unpublished changes",
  saving: "Saving\u2026",
};

function saveLabel(
  saveState: SaveState,
  ackCount: number,
): string {
  if (saveState === "published" && ackCount > 0) {
    return `Saved to ${ackCount} relay(s)`;
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
      {saveState === "unpublished" && (
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
    <span className="last-updated" aria-live="polite">
      {flash && (
        <span className="updated-flash">Updated</span>
      )}
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
  const [saveState, setSaveState] = useState<SaveState>(
    "unpublished",
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
  const [ready, setReady] = useState(false);

  const isReadOnly =
    !doc.capability.namespaces.has("content");
  const canSave = doc.capability.canPushSnapshots;
  const role = doc.role;

  const doSave = useCallback(() => {
    if (!canSave) return;
    setSaveState("saving");
    doc
      .pushSnapshot()
      .then(() => {
        setSaveState("published");
        setLastPublished(Date.now());
      })
      .catch(() => {
        setSaveState("unpublished");
      });
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
    const onSnapshotRec = () => setSaveState("unpublished");
    const onSnapshotApplied = () => {
      setSaveState("published");
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
    doc.on("snapshot-recommended", onSnapshotRec);
    doc.on("snapshot-applied", onSnapshotApplied);
    doc.on("ack", onAck);
    const awareness = doc.awareness;
    awareness.on("change", refreshStatus);

    // Catch any status transition between the initial
    // useState(doc.status) and this subscription.
    refreshStatus();

    return () => {
      doc.off("status", onStatus);
      doc.off("snapshot-recommended", onSnapshotRec);
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

  useEffect(() => {
    if (editingName && nameRef.current) {
      nameRef.current.focus();
      nameRef.current.select();
    }
  }, [editingName]);

  useEffect(() => {
    if (showShare && sharePanelRef.current) {
      sharePanelRef.current.focus();
    }
  }, [showShare]);

  return (
    <div className="app">
      <div className="header">
        <button
          className="back-link"
          onClick={onBack}
          aria-label="Back to document list"
        >
          Back
        </button>
        <h1>Pokapali</h1>
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

