import { docIdFromUrl } from "@pokapali/core";

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
  /** Cached document title */
  title?: string;
}

function isValidEntry(v: unknown): v is RecentDoc {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.url === "string" &&
    e.url.length > 0 &&
    typeof e.docId === "string" &&
    e.docId.length > 0 &&
    typeof e.role === "string" &&
    typeof e.lastOpened === "number" &&
    Number.isFinite(e.lastOpened)
  );
}

export function loadRecent(): RecentDoc[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidEntry);
  } catch {
    return [];
  }
}

export function saveRecent(url: string, role: string, title?: string): void {
  const entries = loadRecent();
  const docId = docIdFromUrl(url);

  // Preserve existing title if not provided
  const existing = entries.find((e) => e.docId === docId);
  const filtered = entries.filter((e) => e.docId !== docId);

  filtered.unshift({
    url,
    docId,
    role,
    lastOpened: Date.now(),
    title: title ?? existing?.title,
  });

  // Trim to max
  if (filtered.length > MAX_ENTRIES) {
    filtered.length = MAX_ENTRIES;
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
  } catch {
    // localStorage unavailable
  }
}

export function updateRecentTitle(docId: string, title: string): void {
  const entries = loadRecent();
  const entry = entries.find((e) => e.docId === docId);
  if (!entry) return;
  entry.title = title;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // localStorage unavailable
  }
}

export function removeRecent(docId: string): void {
  const entries = loadRecent();
  const filtered = entries.filter((e) => e.docId !== docId);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
  } catch {
    // localStorage unavailable
  }
}
