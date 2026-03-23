import { useState, useCallback } from "react";
import type { Doc } from "@pokapali/core";
import { getApp } from "./getApp";
import { RecentDocsList } from "./RecentDocsList";

export function Landing({ onDoc }: { onDoc: (doc: Doc) => void }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const app = await getApp();
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
        const app = await getApp();
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
      <h1>
        Pokapali<span className="app-subtitle">Demo editor</span>
      </h1>
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
