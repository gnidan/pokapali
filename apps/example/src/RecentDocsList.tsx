import { useState, useEffect } from "react";
import { formatAge } from "./utils";
import { loadRecent, removeRecent, type RecentDoc } from "./recentDocs";

function abbreviateId(id: string): string {
  if (id.length <= 12) return id;
  return id.slice(0, 4) + "\u2026" + id.slice(-4);
}

export function RecentDocsList({
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
