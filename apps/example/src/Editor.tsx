import { useState, useEffect, useCallback, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import type { CollabDoc, DocStatus } from "@pokapali/core";
import { StatusIndicator } from "./StatusIndicator";
import { SharePanel } from "./SharePanel";

function capBadge(doc: CollabDoc): { label: string; className: string } {
  if (doc.capability.isAdmin) {
    return { label: "Admin", className: "badge admin" };
  }
  if (doc.capability.namespaces.size > 0) {
    return {
      label: "Writer",
      className: "badge writer",
    };
  }
  return { label: "Reader", className: "badge reader" };
}

export function EditorView({
  doc,
  onBack,
}: {
  doc: CollabDoc;
  onBack: () => void;
}) {
  const [status, setStatus] = useState<DocStatus>(doc.status);
  const [showShare, setShowShare] = useState(false);
  const [snapshotHint, setSnapshotHint] = useState(false);
  const snapshotTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const isReadOnly = !doc.capability.namespaces.has("content");
  const badge = capBadge(doc);

  useEffect(() => {
    const onStatus = (s: DocStatus) => setStatus(s);
    const onSnapshotRec = () => setSnapshotHint(true);
    doc.on("status", onStatus);
    doc.on("snapshot-recommended", onSnapshotRec);

    // Periodic snapshot every 2 minutes
    if (doc.capability.canPushSnapshots) {
      snapshotTimer.current = setInterval(() => {
        if (doc.status === "unpushed-changes") {
          doc.pushSnapshot();
        }
      }, 120_000);
    }

    // Best-effort save on unload
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (doc.status === "unpushed-changes") {
        e.preventDefault();
      }
    };
    const onVisChange = () => {
      if (
        document.visibilityState === "hidden" &&
        doc.status === "unpushed-changes"
      ) {
        doc.pushSnapshot();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisChange);

    return () => {
      doc.off("status", onStatus);
      doc.off("snapshot-recommended", onSnapshotRec);
      if (snapshotTimer.current) {
        clearInterval(snapshotTimer.current);
      }
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisChange);
      doc.destroy();
    };
  }, [doc]);

  const editor = useEditor(
    {
      editable: !isReadOnly,
      extensions: [
        StarterKit.configure({ history: false }),
        Collaboration.configure({
          document: doc.subdoc("content"),
        }),
        CollaborationCursor.configure({
          provider: doc.provider,
        }),
      ],
    },
    [doc],
  );

  const handleSnapshot = useCallback(() => {
    doc.pushSnapshot().then(() => {
      setSnapshotHint(false);
    });
  }, [doc]);

  return (
    <div className="app">
      <div className="header">
        <button className="back-link" onClick={onBack}>
          Back
        </button>
        <h1>Pokapali</h1>
        <span className={badge.className}>{badge.label}</span>
        <StatusIndicator status={status} />
        {doc.capability.canPushSnapshots && (
          <div className="snapshot-controls">
            <button onClick={handleSnapshot}>Save snapshot</button>
            {snapshotHint && (
              <span className="snapshot-hint">Snapshot recommended</span>
            )}
          </div>
        )}
        <button
          className="toggle-share"
          onClick={() => setShowShare((s) => !s)}
        >
          {showShare ? "Hide share" : "Share"}
        </button>
      </div>

      {showShare && <SharePanel doc={doc} />}

      <div className="editor-container">
        {isReadOnly && (
          <div className="read-only-banner">
            Read-only — you cannot edit this document.
          </div>
        )}
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
