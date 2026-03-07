import { useState, useCallback } from "react";
import { createCollabLib } from "@pokapali/core";
import type { CollabDoc } from "@pokapali/core";
import { EditorView } from "./Editor";

const collab = createCollabLib({
  appId: "pokapali-example",
  namespaces: ["content"],
  base: window.location.origin,
  signalingUrls: ["wss://signaling.yjs.dev"],
});

function Landing(
  { onDoc }: { onDoc: (doc: CollabDoc) => void }
) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(
    null
  );

  const handleCreate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const doc = await collab.create();
      onDoc(doc);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : String(e)
      );
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
      setError(
        e instanceof Error ? e.message : String(e)
      );
      setLoading(false);
    }
  }, [url, onDoc]);

  return (
    <div className="landing">
      <h1>Pokapali</h1>
      <p>Collaborative documents, peer-to-peer.</p>
      <div className="landing-actions">
        <button
          onClick={handleCreate}
          disabled={loading}
        >
          {loading
            ? "Loading..."
            : "Create new document"}
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
          <button
            onClick={handleOpen}
            disabled={loading || !url.trim()}
          >
            Open
          </button>
        </div>
        {error && (
          <p style={{ color: "#ef4444" }}>{error}</p>
        )}
      </div>
    </div>
  );
}

export function App() {
  const [doc, setDoc] =
    useState<CollabDoc | null>(null);

  const handleBack = useCallback(() => {
    if (doc) doc.destroy();
    setDoc(null);
  }, [doc]);

  if (doc) {
    return (
      <EditorView doc={doc} onBack={handleBack} />
    );
  }

  return <Landing onDoc={setDoc} />;
}
