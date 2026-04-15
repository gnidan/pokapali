import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useSyncExternalStore,
} from "react";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — y-prosemirror has no type declarations
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import DiffMatchPatch from "diff-match-patch";
import type { Doc, VersionEntry, VersionHistory } from "@pokapali/core";

const dmp = new DiffMatchPatch();

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string };

/** Block-level ProseMirror node types that get
 *  newline separators when extracting text. */
const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "listItem",
  "bulletList",
  "orderedList",
  "horizontalRule",
]);

/** Extract plain text from ProseMirror JSON,
 *  preserving paragraph breaks as newlines. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractText(node: any): string {
  if (typeof node.text === "string") return node.text;
  if (Array.isArray(node.content)) {
    return (
      node.content
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((child: any) => {
          const text = extractText(child);
          if (BLOCK_TYPES.has(child.type)) {
            return text + "\n";
          }
          return text;
        })
        .join("")
    );
  }
  return "";
}

export interface VersionHistoryData {
  versions: VersionEntry[];
  listState: LoadState;
  versionTexts: Map<number, string>;
  deltas: Map<number, number>;
  visibleVersions: VersionEntry[];
  /**
   * True when the list fetch returned empty but the
   * doc has content (tipCid), so more versions may
   * still arrive from IDB or the network.
   */
  settling: boolean;
}

/**
 * Fetch version history and background-preload text
 * for diff indicators. Runs on doc mount so data is
 * ready before the history drawer opens.
 */
export function useVersionHistory(doc: Doc): VersionHistoryData {
  // --- Baseline: reactive versions feed ---
  // The feed is the source of truth for known
  // versions (from Store cache + network).
  const feedSnapshot: VersionHistory = useSyncExternalStore(
    doc.versions.subscribe,
    doc.versions.getSnapshot,
  );

  // Pinner metadata (tier, expiresAt) keyed by
  // CID string. Enriches feed entries.
  const [pinnerMeta, setPinnerMeta] = useState<
    Map<string, { tier?: VersionEntry["tier"]; expiresAt?: number | null }>
  >(new Map());

  const [listState, setListState] = useState<LoadState>({
    status: "loading",
  });
  const [versionTexts, setVersionTexts] = useState<Map<number, string>>(
    new Map(),
  );
  const cancelRef = useRef(false);
  const loadedSeqsRef = useRef<Set<number>>(new Set());
  const failedAttemptsRef = useRef(new Map<number, number>());

  const tipCid = doc.tip.getSnapshot()?.cid ?? null;
  const tipCidStr = tipCid?.toString() ?? null;

  // Merge feed entries with pinner metadata to
  // produce the final versions list (sorted by
  // seq desc).
  const versions: VersionEntry[] = useMemo(() => {
    const entries: VersionEntry[] = feedSnapshot.entries.map((e) => {
      const key = e.cid.toString();
      const meta = pinnerMeta.get(key);
      return {
        cid: e.cid,
        seq: e.seq,
        ts: e.ts,
        ...(meta?.tier ? { tier: meta.tier } : {}),
        ...(meta?.expiresAt !== undefined ? { expiresAt: meta.expiresAt } : {}),
      };
    });
    // Sort by seq descending (newest first).
    entries.sort((a, b) => b.seq - a.seq);
    return entries;
  }, [feedSnapshot, pinnerMeta]);

  // Fetch pinner metadata + trigger version
  // discovery (which also persists to Store).
  useEffect(() => {
    cancelRef.current = false;
    let fetched = false;
    let hasTierData = false;

    const doFetch = () => {
      doc
        .versionHistory()
        .then((entries) => {
          if (cancelRef.current) return;
          hasTierData = entries.some((e) => e.tier != null);
          // Store pinner metadata; the feed handles
          // the actual entry list.
          const meta = new Map<
            string,
            {
              tier?: VersionEntry["tier"];
              expiresAt?: number | null;
            }
          >();
          for (const e of entries) {
            if (e.tier != null || e.expiresAt !== undefined) {
              meta.set(e.cid.toString(), {
                tier: e.tier,
                expiresAt: e.expiresAt,
              });
            }
          }
          setPinnerMeta((prev) => {
            if (meta.size === 0 && prev.size === 0) {
              return prev;
            }
            // Merge with existing metadata
            const merged = new Map(prev);
            for (const [k, v] of meta) {
              merged.set(k, v);
            }
            return merged;
          });
          setListState({ status: "idle" });
        })
        .catch((err) => {
          if (cancelRef.current) return;
          setListState({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        });
    };

    const fetchHistory = () => {
      if (cancelRef.current || fetched) return;
      fetched = true;
      doFetch();
    };

    doc.ready().then(fetchHistory);

    // Fallback: fetch after 60s even if doc.ready()
    // hasn't resolved (matches Editor's timeout).
    const timeout = setTimeout(fetchHistory, 60_000);

    // Mark idle once feed has entries even if pinner
    // fetch hasn't completed yet.
    const unsubSnapshot = doc.snapshotEvents.subscribe(() => {
      const e = doc.snapshotEvents.getSnapshot();
      if (!e) return;
      if (cancelRef.current) return;
      if (!fetched) fetchHistory();
      setListState((s) => (s.status === "idle" ? s : { status: "idle" }));
    });

    // Re-fetch when a new node appears (may now
    // have httpUrl for enriched tier data).
    const onNodeChange = () => {
      if (cancelRef.current || !fetched || hasTierData) {
        return;
      }
      doFetch();
    };
    doc.on("node-change", onNodeChange);

    return () => {
      cancelRef.current = true;
      clearTimeout(timeout);
      unsubSnapshot();
      doc.off("node-change", onNodeChange);
    };
  }, [doc]);

  // Transition to idle once the feed has entries
  // (cached versions from Store), even before the
  // pinner fetch completes.
  useEffect(() => {
    if (listState.status === "loading" && feedSnapshot.entries.length > 0) {
      setListState({ status: "idle" });
    }
  }, [listState.status, feedSnapshot.entries.length]);

  // Background-preload versions for diff indicators
  // and inline diff highlighting.
  useEffect(() => {
    if (listState.status !== "idle" || versions.length === 0) {
      return;
    }
    let cancelled = false;

    (async () => {
      for (const entry of versions) {
        if (cancelled) break;
        if (loadedSeqsRef.current.has(entry.seq)) continue;
        try {
          const channels = await doc.loadVersion(entry.cid);
          if (cancelled) break;
          const ydoc = channels["content"] ?? Object.values(channels)[0];
          if (!ydoc) {
            loadedSeqsRef.current.add(entry.seq);
            continue;
          }
          const frag = ydoc.getXmlFragment("default");
          const json = yXmlFragmentToProsemirrorJSON(frag);
          const text = extractText(json);
          loadedSeqsRef.current.add(entry.seq);
          setVersionTexts((prev) => {
            const next = new Map(prev);
            next.set(entry.seq, text);
            return next;
          });
        } catch {
          const attempts = (failedAttemptsRef.current.get(entry.seq) ?? 0) + 1;
          failedAttemptsRef.current.set(entry.seq, attempts);
          if (attempts >= 3) {
            loadedSeqsRef.current.add(entry.seq);
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [doc, listState.status, versions]);

  const deltas = useMemo(() => {
    const result = new Map<number, number>();
    for (let i = 0; i < versions.length; i++) {
      const text = versionTexts.get(versions[i]!.seq);
      if (text === undefined) continue;
      const next = versions[i + 1];
      if (!next) {
        // First version — all content is "added"
        result.set(versions[i]!.seq, text.length);
        continue;
      }
      const prevText = versionTexts.get(next.seq);
      if (prevText === undefined) continue;
      // Use diff-match-patch for accurate change
      // counts that match the overlay's diff display.
      const diffs = dmp.diff_main(prevText, text);
      let inserted = 0;
      let deleted = 0;
      for (const [op, seg] of diffs) {
        if (op === DiffMatchPatch.DIFF_INSERT) {
          inserted += seg.length;
        } else if (op === DiffMatchPatch.DIFF_DELETE) {
          deleted += seg.length;
        }
      }
      result.set(versions[i]!.seq, inserted - deleted);
    }
    return result;
  }, [versions, versionTexts]);

  // Fall back to newest version CID when tipFeed
  // hasn't been updated yet (e.g. no-P2P mode).
  const effectiveTipCidStr = tipCidStr ?? versions[0]?.cid.toString() ?? null;

  const visibleVersions = useMemo(() => {
    return versions.filter((entry) => {
      const delta = deltas.get(entry.seq);
      if (delta === undefined) return true;
      if (delta !== 0) return true;
      if (
        effectiveTipCidStr != null &&
        entry.cid.toString() === effectiveTipCidStr
      ) {
        return true;
      }
      return false;
    });
  }, [versions, deltas, effectiveTipCidStr]);

  // Still settling: list fetched OK with zero results
  // but the doc has a tip CID (content exists), so IDB
  // or network may still deliver version history.
  const settling =
    listState.status === "idle" &&
    versions.length === 0 &&
    effectiveTipCidStr != null;

  return {
    versions,
    listState,
    versionTexts,
    deltas,
    visibleVersions,
    settling,
  };
}
