import {
  useState,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { createCollabLib } from "@pokapali/core";
import type { CollabDoc } from "@pokapali/core";
import { EditorView } from "./Editor";
import {
  loadRecent,
  saveRecent,
  removeRecent,
  type RecentDoc,
} from "./recentDocs";

const collab = createCollabLib({
  appId: "pokapali-example",
  namespaces: ["content"],
  base: window.location.origin +
    import.meta.env.BASE_URL.replace(/\/$/, ""),
});

function roleOf(doc: CollabDoc): string {
  if (doc.capability.isAdmin) return "Admin";
  if (doc.capability.namespaces.size > 0) return "Writer";
  return "Reader";
}

function bestUrl(doc: CollabDoc): string {
  return doc.adminUrl ?? doc.writeUrl ?? doc.readUrl;
}

function recordDoc(doc: CollabDoc) {
  saveRecent(bestUrl(doc), roleOf(doc));
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

  const handleCreate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const doc = await collab.create();
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
        const doc = await collab.open(rawUrl);
        onDoc(doc);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : String(e),
        );
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
          <div className="landing-error">
            <p>{error}</p>
            <button
              onClick={() => {
                setError(null);
                setLoading(false);
              }}
            >
              Dismiss
            </button>
          </div>
        )}
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
  const docRef = useRef<CollabDoc | null>(null);

  // Keep ref in sync so popstate handler sees current doc
  docRef.current = doc;

  const openDoc = useCallback(
    (d: CollabDoc, replace = false) => {
      recordDoc(d);
      setDoc(d);
      const url = bestUrl(d);
      if (replace) {
        window.history.replaceState(null, "", url);
      } else {
        window.history.pushState(null, "", url);
      }
    },
    [],
  );

  const goToLanding = useCallback(() => {
    if (docRef.current) {
      docRef.current.destroy();
    }
    setDoc(null);
    setAutoOpening(false);
    setError(null);
  }, []);

  // Auto-open if URL contains a doc path on mount
  useEffect(() => {
    const url = window.location.href;
    if (!isDocUrl(url)) return;

    let cancelled = false;
    setAutoOpening(true);
    collab.open(url).then(
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
        if (!cancelled) {
          setError(
            e instanceof Error
              ? e.message
              : String(e),
          );
          setAutoOpening(false);
        }
      },
    );
    return () => { cancelled = true; };
  }, [openDoc]);

  // Handle browser back/forward — only go to landing
  // if the URL no longer points to a document
  useEffect(() => {
    const onPopState = () => {
      if (!isDocUrl(window.location.href)) {
        goToLanding();
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener(
        "popstate",
        onPopState,
      );
    };
  }, [goToLanding]);

  const handleBack = useCallback(() => {
    goToLanding();
    window.history.pushState(
      null,
      "",
      import.meta.env.BASE_URL,
    );
  }, [goToLanding]);

  if (doc) {
    return <EditorView doc={doc} onBack={handleBack} />;
  }

  if (autoOpening) {
    return (
      <div className="landing">
        <h1>Pokapali</h1>
        <p>Loading\u2026</p>
        {error && (
          <div className="landing-error">
            <p>{error}</p>
            <button onClick={goToLanding}>
              Back to home
            </button>
          </div>
        )}
      </div>
    );
  }

  return <Landing onDoc={openDoc} />;
}
