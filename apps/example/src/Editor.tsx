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

function capBadge(doc: CollabDoc): { label: string; className: string } {
  if (doc.capability.isAdmin) {
    return { label: "Admin", className: "badge admin" };
  }
  if (doc.capability.namespaces.size > 0) {
    return {
      label: "Writer",
      className: "badge writer",
    };
  }
  return { label: "Reader", className: "badge reader" };
}

type SaveState =
  | "published"
  | "unpublished"
  | "saving";

const DEBOUNCE_MS = 10_000;

const SAVE_LABELS: Record<SaveState, string> = {
  published: "Published",
  unpublished: "Unpublished changes",
  saving: "Saving\u2026",
};

function SaveIndicator({
  saveState,
  onPublish,
}: {
  saveState: SaveState;
  onPublish: () => void;
}) {
  return (
    <div className="save-indicator">
      <span className={`save-state ${saveState}`}>
        {SAVE_LABELS[saveState]}
      </span>
      {saveState === "unpublished" && (
        <button
          className="publish-now"
          onClick={onPublish}
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
    <span className="last-updated">
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
  const [status, setStatus] = useState<DocStatus>(doc.status);
  const [showShare, setShowShare] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>(
    doc.status === "unpushed-changes"
      ? "unpublished"
      : "published",
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout>
    | null>(null);
  const [lastPublished, setLastPublished] = useState(
    Date.now(),
  );
  const [updateFlash, setUpdateFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout>
    | null>(null);
  const [user, setUser] = useState<StoredUser>(loadUser);
  const [editingName, setEditingName] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const isReadOnly =
    !doc.capability.namespaces.has("content");
  const canSave = doc.capability.canPushSnapshots;
  const badge = capBadge(doc);

  const doSave = useCallback(() => {
    if (!canSave) return;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setSaveState("saving");
    doc.pushSnapshot().then(() => {
      setSaveState("published");
      setLastPublished(Date.now());
    }).catch(() => {
      setSaveState("unpublished");
    });
  }, [doc, canSave]);

  const startDebounce = useCallback(() => {
    if (!canSave) return;
    setSaveState("unpublished");
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      doSave();
    }, DEBOUNCE_MS);
  }, [canSave, doSave]);

  useEffect(() => {
    const onStatus = (s: DocStatus) => setStatus(s);
    const onSnapshotRec = () => startDebounce();
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
    };
    doc.on("status", onStatus);
    doc.on("snapshot-recommended", onSnapshotRec);
    doc.on("snapshot-applied", onSnapshotApplied);

    // Best-effort save on unload
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (doc.status === "unpushed-changes") {
        e.preventDefault();
      }
    };
    const onVisChange = () => {
      if (
        document.visibilityState === "hidden" &&
        doc.status === "unpushed-changes"
      ) {
        doc.pushSnapshot();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener(
      "visibilitychange",
      onVisChange,
    );

    return () => {
      doc.off("status", onStatus);
      doc.off("snapshot-recommended", onSnapshotRec);
      doc.off("snapshot-applied", onSnapshotApplied);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      if (flashTimer.current) {
        clearTimeout(flashTimer.current);
      }
      window.removeEventListener(
        "beforeunload",
        onBeforeUnload,
      );
      document.removeEventListener(
        "visibilitychange",
        onVisChange,
      );
      doc.destroy();
    };
  }, [doc, startDebounce]);

  const editor = useEditor(
    {
      editable: !isReadOnly,
      extensions: [
        StarterKit.configure({ history: false }),
        Collaboration.configure({
          document: doc.subdoc("content"),
        }),
        CollaborationCursor.configure({
          provider: doc.provider,
          render: renderCursor,
        }),
      ],
    },
    [doc],
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

  return (
    <div className="app">
      <div className="header">
        <button className="back-link" onClick={onBack}>
          Back
        </button>
        <h1>Pokapali</h1>
        <span className={badge.className}>{badge.label}</span>
        {editingName ? (
          <input
            ref={nameRef}
            className="user-name-input"
            value={user.name}
            placeholder="Your name"
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
            className="user-name-display"
            onClick={() => setEditingName(true)}
            title="Click to change your name"
            style={{ borderColor: user.color }}
          >
            {user.name || "Set name..."}
          </button>
        )}
        <StatusIndicator status={status} />
        {canSave ? (
          <SaveIndicator
            saveState={saveState}
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
        >
          {showShare ? "Hide share" : "Share"}
        </button>
      </div>

      {showShare && <SharePanel doc={doc} />}

      <div className="editor-container">
        {isReadOnly && status === "connecting" && (
          <div className="resolving-banner">
            Resolving document\u2026
          </div>
        )}
        {isReadOnly && status !== "connecting" && (
          <div className="read-only-banner">
            Read-only — you cannot edit this document.
          </div>
        )}
        <EditorContent editor={editor} />
      </div>

      <ConnectionStatus doc={doc} />
    </div>
  );
}
