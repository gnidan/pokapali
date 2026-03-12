import { useState, useCallback, useEffect } from "react";
import { pokapali } from "@pokapali/core";
import type { Doc } from "@pokapali/core";
import { EditorView } from "./Editor";
import { capitalize, formatAge } from "./utils";
import {
  loadRecent,
  saveRecent,
  removeRecent,
  type RecentDoc,
} from "./recentDocs";

function abbreviateId(id: string): string {
  if (id.length <= 12) return id;
  return id.slice(0, 4) + "\u2026" + id.slice(-4);
}

// Persist across Vite HMR to avoid duplicate
// Helia/WebRTC instances on hot reload
function getApp() {
  if (import.meta.hot?.data.app) {
    return import.meta.hot.data.app as ReturnType<typeof pokapali>;
  }
  const instance = pokapali({
    appId: "pokapali-example",
    channels: ["content"],
    origin:
      window.location.origin + import.meta.env.BASE_URL.replace(/\/$/, ""),
  });
  if (import.meta.hot) {
    import.meta.hot.data.app = instance;
  }
  return instance;
}

const app = getApp();

function recordDoc(doc: Doc) {
  saveRecent(doc.urls.best, capitalize(doc.role));
}

function RecentDocsList({
  onOpen,
  loading,
}: {
  onOpen: (url: string) => void;
  loading: boolean;
}) {
  const [docs, setDocs] = useState<RecentDoc[]>(loadRecent);
  const [, tick] = useState(0);

  // Re-render periodically so relative ages stay fresh
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  if (docs.length === 0) {
    return (
      <div className="empty-state">
        <p>
          End-to-end encrypted, no sign-up required. Create a document and share
          the link to start collaborating.
        </p>
      </div>
    );
  }

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
              aria-label={`Open ${d.title || "Untitled"}, ${d.role}, ${formatAge(d.lastOpened)}`}
            >
              <span className="recent-title" title={d.title || "Untitled"}>
                {d.title || "Untitled"}
              </span>
              <span className="recent-id-pill">{abbreviateId(d.docId)}</span>
              <span className={"badge " + d.role.toLowerCase()}>{d.role}</span>
              <span className="recent-age">{formatAge(d.lastOpened)}</span>
            </button>
            <button
              className="recent-remove"
              title="Remove"
              aria-label={`Remove document ${d.docId} from recent list`}
              onClick={() =>
                setDocs((prev) => {
                  removeRecent(d.docId);
                  return prev.filter((e) => e.docId !== d.docId);
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

function Landing({ onDoc }: { onDoc: (doc: Doc) => void }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const doc = await app.create();
      onDoc(doc);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }, [onDoc]);

  const openByUrl = useCallback(
    async (rawUrl: string) => {
      setLoading(true);
      setError(null);
      try {
        const doc = await app.open(rawUrl);
        onDoc(doc);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    },
    [onDoc],
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
          {loading ? "Loading\u2026" : "Create new document"}
        </button>
        <div className="open-form">
          <input
            type="text"
            placeholder="Paste a capability URL..."
            aria-label="Document capability URL"
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
        {error && (
          <div className="landing-error" role="alert">
            <p>{error}</p>
            <button
              onClick={() => {
                setError(null);
                setLoading(false);
              }}
              aria-label="Dismiss error"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
      <RecentDocsList onOpen={openByUrl} loading={loading} />
    </div>
  );
}

export function App() {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [autoOpening, setAutoOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openDoc = useCallback((d: Doc, replace = false) => {
    recordDoc(d);
    setDoc(d);
    const url = d.urls.best;
    if (replace) {
      window.history.replaceState(null, "", url);
    } else {
      window.history.pushState(null, "", url);
    }
  }, []);

  const goToLanding = useCallback(() => {
    setDoc(null);
    setAutoOpening(false);
    setError(null);
  }, []);

  // Auto-open if URL contains a doc path on mount
  useEffect(() => {
    const url = window.location.href;
    if (!app.isDocUrl(url)) return;

    let cancelled = false;
    setAutoOpening(true);
    app.open(url).then(
      (d) => {
        if (!cancelled) {
          // Replace so back goes to wherever the
          // user came from, not the bare doc URL
          openDoc(d, true);
          setAutoOpening(false);
        } else {
          d.destroy();
        }
      },
      (e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setAutoOpening(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [openDoc]);

  // Handle browser back/forward — only go to landing
  // if the URL no longer points to a document
  useEffect(() => {
    const onPopState = () => {
      if (!app.isDocUrl(window.location.href)) {
        goToLanding();
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, [goToLanding]);

  const handleBack = useCallback(() => {
    goToLanding();
    window.history.pushState(null, "", import.meta.env.BASE_URL);
  }, [goToLanding]);

  if (doc) {
    return <EditorView doc={doc} onBack={handleBack} />;
  }

  if (autoOpening) {
    return (
      <div className="landing">
        <h1>Pokapali</h1>
        <p>Loading…</p>
        <button onClick={goToLanding}>Cancel</button>
        {error && (
          <div className="landing-error" role="alert">
            <p>{error}</p>
            <button onClick={goToLanding}>Back to home</button>
          </div>
        )}
      </div>
    );
  }

  return <Landing onDoc={openDoc} />;
}
