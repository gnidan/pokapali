import { useState, useEffect, useRef, useMemo } from "react";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — y-prosemirror has no type declarations
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import DiffMatchPatch from "diff-match-patch";
import type { Doc, VersionEntry } from "@pokapali/core";

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
}

/**
 * Fetch version history and background-preload text
 * for diff indicators. Runs on doc mount so data is
 * ready before the history drawer opens.
 */
export function useVersionHistory(doc: Doc): VersionHistoryData {
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [listState, setListState] = useState<LoadState>({
    status: "loading",
  });
  const [versionTexts, setVersionTexts] = useState<Map<number, string>>(
    new Map(),
  );
  const cancelRef = useRef(false);
  const loadedSeqsRef = useRef<Set<number>>(new Set());

  const tipCidStr = doc.tipCid?.toString() ?? null;

  // Fetch version list + listen for new snapshots.
  // Wait for doc.ready() before fetching so the local
  // chain has been loaded (fixes empty-history regression
  // when pinner HTTP index is unavailable).
  useEffect(() => {
    cancelRef.current = false;
    setListState({ status: "loading" });
    let fetched = false;

    const fetchHistory = () => {
      if (cancelRef.current || fetched) return;
      fetched = true;
      doc
        .versionHistory()
        .then((entries) => {
          if (cancelRef.current) return;
          setVersions(entries);
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

    doc.ready().then(fetchHistory);

    const onSnapshot = (e: { cid: unknown; seq: number; ts: number }) => {
      if (cancelRef.current) return;
      // If we haven't fetched yet, trigger fetch now
      // since the doc clearly has data.
      if (!fetched) fetchHistory();
      setVersions((prev) => {
        if (prev.some((v) => v.seq === e.seq)) return prev;
        const entry: VersionEntry = {
          cid: e.cid as VersionEntry["cid"],
          seq: e.seq,
          ts: e.ts,
        };
        return [entry, ...prev];
      });
      setListState((s) => (s.status === "idle" ? s : { status: "idle" }));
    };
    doc.on("snapshot", onSnapshot);

    return () => {
      cancelRef.current = true;
      doc.off("snapshot", onSnapshot);
    };
  }, [doc]);

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
          const channels = await doc.loadVersion(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            entry.cid as any,
          );
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
          loadedSeqsRef.current.add(entry.seq);
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
      const text = versionTexts.get(versions[i].seq);
      if (text === undefined) continue;
      const next = versions[i + 1];
      if (!next) {
        // First version — all content is "added"
        result.set(versions[i].seq, text.length);
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
      result.set(versions[i].seq, inserted - deleted);
    }
    return result;
  }, [versions, versionTexts]);

  const visibleVersions = useMemo(() => {
    return versions.filter((entry) => {
      const delta = deltas.get(entry.seq);
      if (delta === undefined) return true;
      if (delta !== 0) return true;
      if (tipCidStr != null && entry.cid.toString() === tipCidStr) {
        return true;
      }
      return false;
    });
  }, [versions, deltas, tipCidStr]);

  return {
    versions,
    listState,
    versionTexts,
    deltas,
    visibleVersions,
  };
}
