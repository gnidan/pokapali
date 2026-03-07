import { useState, useCallback, useEffect } from "react";
import { createCollabLib } from "@pokapali/core";
import type { CollabDoc } from "@pokapali/core";
import { EditorView } from "./Editor";

const LOCAL_SIGNALING = "ws://localhost:4444";

const signalingParam = new URLSearchParams(
  window.location.search,
).get("signaling");

const signalingUrls =
  window.location.hostname === "localhost"
    ? [signalingParam || LOCAL_SIGNALING]
    : signalingParam
      ? [signalingParam]
      : [];

const collab = createCollabLib({
  appId: "pokapali-example",
  namespaces: ["content"],
  base: window.location.origin +
    import.meta.env.BASE_URL.replace(/\/$/, ""),
  signalingUrls,
});

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

  const handleOpen = useCallback(async () => {
    if (!url.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const doc = await collab.open(url.trim());
      onDoc(doc);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }, [url, onDoc]);

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
        if (!cancelled) setDoc(d);
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
