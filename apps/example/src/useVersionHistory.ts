import { useState, useEffect, useRef, useMemo } from "react";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — y-prosemirror has no type declarations
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import type { Doc, VersionEntry } from "@pokapali/core";

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string };

/** Extract plain text from ProseMirror JSON. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractText(node: any): string {
  if (typeof node.text === "string") return node.text;
  if (Array.isArray(node.content)) {
    return node.content.map(extractText).join("");
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

  // Fetch version list + listen for new snapshots
  useEffect(() => {
    cancelRef.current = false;
    setListState({ status: "loading" });

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

    const onSnapshot = (e: { cid: unknown; seq: number; ts: number }) => {
      if (cancelRef.current) return;
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
        result.set(versions[i].seq, text.length);
        continue;
      }
      const prevText = versionTexts.get(next.seq);
      if (prevText === undefined) continue;
      result.set(versions[i].seq, text.length - prevText.length);
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
