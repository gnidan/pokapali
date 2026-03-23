import { useState, useCallback, useEffect, lazy, Suspense } from "react";
import type { Doc } from "@pokapali/core";
import { capitalize } from "./utils";
import { saveRecent } from "./recentDocs";
import { getApp } from "./getApp";
import { Landing } from "./Landing";

const LazyEditorView = lazy(() =>
  import("./Editor").then((m) => ({
    default: m.EditorView,
  })),
);

// Lightweight URL check that doesn't require
// loading @pokapali/core. Mirrors the logic in
// PokapaliApp.isDocUrl() — origin match, /doc/
// path prefix, and a hash fragment.
function isDocUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const base =
      window.location.origin + import.meta.env.BASE_URL.replace(/\/$/, "");
    const prefix = new URL(base + "/doc/");
    return (
      parsed.origin === prefix.origin &&
      parsed.pathname.startsWith(prefix.pathname) &&
      parsed.hash.length > 1
    );
  } catch {
    return false;
  }
}

function recordDoc(doc: Doc) {
  saveRecent(doc.urls.best, capitalize(doc.role));
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

  // Auto-open if URL contains a doc path on mount.
  // Uses inline isDocUrl() — no core import needed.
  useEffect(() => {
    const url = window.location.href;
    if (!isDocUrl(url)) return;

    let cancelled = false;
    setAutoOpening(true);
    getApp().then((app) =>
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
      ),
    );
    return () => {
      cancelled = true;
    };
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
      window.removeEventListener("popstate", onPopState);
    };
  }, [goToLanding]);

  const handleBack = useCallback(() => {
    goToLanding();
    window.history.pushState(null, "", import.meta.env.BASE_URL);
  }, [goToLanding]);

  if (doc) {
    return (
      <Suspense
        fallback={
          <div className="landing">
            <h1>
              Pokapali<span className="app-subtitle">Demo editor</span>
            </h1>
            <p>Loading editor…</p>
          </div>
        }
      >
        <LazyEditorView doc={doc} onBack={handleBack} />
      </Suspense>
    );
  }

  if (autoOpening) {
    return (
      <div className="landing">
        <h1>
          Pokapali<span className="app-subtitle">Demo editor</span>
        </h1>
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
