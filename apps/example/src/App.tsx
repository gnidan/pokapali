import { useState, useCallback, useEffect } from "react";
import { createCollabLib } from "@pokapali/core";
import type { CollabDoc } from "@pokapali/core";
import { EditorView } from "./Editor";
import {
  loadRecent,
  saveRecent,
  removeRecent,
  type RecentDoc,
} from "./recentDocs";

const LOCAL_SIGNALING = "ws://localhost:4444";
const PUBLIC_SIGNALING =
  "wss://signaling.yjs.dev";

const signalingParam = new URLSearchParams(
  window.location.search,
).get("signaling");

const signalingUrls =
  window.location.hostname === "localhost"
    ? [LOCAL_SIGNALING, PUBLIC_SIGNALING]
    : [signalingParam || PUBLIC_SIGNALING];

const collab = createCollabLib({
  appId: "pokapali-example",
  namespaces: ["content"],
  base: window.location.origin +
    import.meta.env.BASE_URL.replace(/\/$/, ""),
  signalingUrls,
});

function roleOf(doc: CollabDoc): string {
  if (doc.capability.isAdmin) return "Admin";
  if (doc.capability.namespaces.size > 0) return "Writer";
  return "Reader";
}

function recordDoc(doc: CollabDoc) {
  const url =
    doc.adminUrl ?? doc.writeUrl ?? doc.readUrl;
  saveRecent(url, roleOf(doc));
}

function formatAge(ts: number): string {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

function RecentDocsList({
  onOpen,
  loading,
}: {
  onOpen: (url: string) => void;
  loading: boolean;
}) {
  const [docs, setDocs] = useState<RecentDoc[]>(
    loadRecent,
  );

  if (docs.length === 0) return null;

  return (
    <div className="recent-docs">
      <h3>Recent documents</h3>
      <ul className="recent-list">
        {docs.map((d) => (
          <li key={d.docId} className="recent-item">
            <button
              className="recent-link"
              disabled={loading}
              onClick={() => onOpen(d.url)}
            >
              <span className="recent-id">
                {d.docId}
              </span>
              <span className={
                "badge " + d.role.toLowerCase()
              }>
                {d.role}
              </span>
              <span className="recent-age">
                {formatAge(d.lastOpened)}
              </span>
            </button>
            <button
              className="recent-remove"
              title="Remove"
              onClick={() =>
                setDocs((prev) => {
                  removeRecent(d.docId);
                  return prev.filter(
                    (e) => e.docId !== d.docId,
                  );
                })
              }
            >
              &times;
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Landing({ onDoc }: { onDoc: (doc: CollabDoc) => void }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openAndRecord = useCallback(
    (doc: CollabDoc) => {
      recordDoc(doc);
      onDoc(doc);
    },
    [onDoc],
  );

  const handleCreate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const doc = await collab.create();
      openAndRecord(doc);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }, [openAndRecord]);

  const openByUrl = useCallback(
    async (rawUrl: string) => {
      setLoading(true);
      setError(null);
      try {
        const doc = await collab.open(rawUrl);
        openAndRecord(doc);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : String(e),
        );
        setLoading(false);
      }
    },
    [openAndRecord],
  );

  const handleOpen = useCallback(async () => {
    if (!url.trim()) return;
    await openByUrl(url.trim());
  }, [url, openByUrl]);

  return (
    <div className="landing">
      <h1>Pokapali</h1>
      <p>Collaborative documents, peer-to-peer.</p>
      <div className="landing-actions">
        <button onClick={handleCreate} disabled={loading}>
          {loading ? "Loading..." : "Create new document"}
        </button>
        <div className="open-form">
          <input
            type="text"
            placeholder="Paste a capability URL..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleOpen();
            }}
          />
          <button onClick={handleOpen} disabled={loading || !url.trim()}>
            Open
          </button>
        </div>
        {error && <p style={{ color: "#ef4444" }}>{error}</p>}
      </div>
      <RecentDocsList
        onOpen={openByUrl}
        loading={loading}
      />
    </div>
  );
}

function isDocUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const base = import.meta.env.BASE_URL.replace(
      /\/$/,
      "",
    );
    return parsed.pathname.startsWith(
      base + "/doc/",
    ) && parsed.hash.length > 1;
  } catch {
    return false;
  }
}

export function App() {
  const [doc, setDoc] = useState<CollabDoc | null>(null);
  const [autoOpening, setAutoOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const url = window.location.href;
    if (!isDocUrl(url)) return;

    let cancelled = false;
    setAutoOpening(true);
    collab.open(url).then(
      (d) => {
        if (!cancelled) {
          recordDoc(d);
          setDoc(d);
        }
      },
      (e) => {
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : String(e),
          );
          setAutoOpening(false);
        }
      },
    );
    return () => { cancelled = true; };
  }, []);

  const handleBack = useCallback(() => {
    if (doc) doc.destroy();
    setDoc(null);
    window.history.pushState(
      null,
      "",
      import.meta.env.BASE_URL,
    );
  }, [doc]);

  if (doc) {
    return <EditorView doc={doc} onBack={handleBack} />;
  }

  if (autoOpening) {
    return (
      <div className="landing">
        <h1>Pokapali</h1>
        <p>Opening document...</p>
        {error && <p style={{ color: "#ef4444" }}>{error}</p>}
      </div>
    );
  }

  return <Landing onDoc={setDoc} />;
}
