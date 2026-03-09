const STORAGE_KEY = "pokapali:recent-docs";
const MAX_ENTRIES = 15;

export interface RecentDoc {
  /** The best URL we have for reopening (admin > write > read) */
  url: string;
  /** Short ID extracted from the URL path */
  docId: string;
  /** "Admin" | "Writer" | "Reader" */
  role: string;
  /** Unix ms timestamp of last open */
  lastOpened: number;
}

export function loadRecent(): RecentDoc[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function docIdFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Path looks like /base/doc/<id>
    const parts = parsed.pathname.split("/");
    const docIdx = parts.indexOf("doc");
    if (docIdx >= 0 && parts[docIdx + 1]) {
      const id = parts[docIdx + 1];
      return id.length > 12
        ? id.slice(0, 6) + "\u2026" + id.slice(-6)
        : id;
    }
  } catch {}
  return "unknown";
}

export function saveRecent(
  url: string,
  role: string,
): void {
  const entries = loadRecent();
  const docId = docIdFromUrl(url);

  // Remove any existing entry with the same docId
  const filtered = entries.filter(
    (e) => e.docId !== docId,
  );

  filtered.unshift({
    url,
    docId,
    role,
    lastOpened: Date.now(),
  });

  // Trim to max
  if (filtered.length > MAX_ENTRIES) {
    filtered.length = MAX_ENTRIES;
  }

  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(filtered),
    );
  } catch {}
}

export function removeRecent(docId: string): void {
  const entries = loadRecent();
  const filtered = entries.filter(
    (e) => e.docId !== docId,
  );
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(filtered),
    );
  } catch {}
}
