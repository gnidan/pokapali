import {
  useState,
  useCallback,
  useRef,
  useEffect,
} from "react";
import type { CollabDoc } from "@pokapali/core";
import { truncateUrl } from "@pokapali/core";

function CopyRow({
  label,
  description,
  value,
}: {
  label: string;
  description: string;
  value: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(
        () => setCopied(false),
        1500,
      );
    });
  }, [value]);

  return (
    <div className="share-card">
      <div className="share-card-header">
        <span className="share-card-label">
          {label}
        </span>
        <span className="share-card-desc">
          {description}
        </span>
      </div>
      <div className="share-card-row">
        <input
          type="text"
          readOnly
          value={truncateUrl(value)}
          title={value}
          onFocus={(e) => {
            e.target.value = value;
            e.target.select();
          }}
          onBlur={(e) => {
            e.target.value = truncateUrl(value);
          }}
        />
        <button
          className="copy-btn"
          onClick={copy}
        >
          {copied ? "Copied!" : "Copy link"}
        </button>
      </div>
    </div>
  );
}

function InviteButton({
  doc,
}: {
  doc: CollabDoc;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(
    null,
  );
  const timer = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const flashCopied = useCallback(() => {
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setCopied(false),
      1500,
    );
  }, []);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const inviteUrl = await doc.inviteUrl({
        namespaces: ["content"],
      });
      setUrl(inviteUrl);
      await navigator.clipboard.writeText(inviteUrl);
      flashCopied();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setLoading(false);
    }
  }, [doc, flashCopied]);

  const copyExisting = useCallback(() => {
    if (!url) return;
    navigator.clipboard.writeText(url).then(() => {
      flashCopied();
    });
  }, [url, flashCopied]);

  return (
    <div className="share-card">
      <div className="share-card-header">
        <span className="share-card-label">
          Invite
        </span>
        <span className="share-card-desc">
          Generate a write-access link for a
          collaborator
        </span>
      </div>
      {url ? (
        <div className="share-card-row">
          <input
            type="text"
            readOnly
            value={truncateUrl(url)}
            title={url}
            onFocus={(e) => {
              e.target.value = url;
              e.target.select();
            }}
            onBlur={(e) => {
              e.target.value = truncateUrl(url);
            }}
          />
          <button
            className="copy-btn"
            onClick={copyExisting}
          >
            {copied ? "Copied!" : "Copy link"}
          </button>
        </div>
      ) : (
        <div className="share-card-row">
          <button
            className="generate-btn"
            onClick={generate}
            disabled={loading}
          >
            {loading
              ? "Generating\u2026"
              : "Generate invite link"}
          </button>
        </div>
      )}
      {error && (
        <div className="share-error">{error}</div>
      )}
    </div>
  );
}

export function SharePanel({
  doc,
}: {
  doc: CollabDoc;
}) {
  const isAdmin = doc.capability.isAdmin;
  const canWrite =
    doc.capability.namespaces.has("content");

  return (
    <div className="share-panel">
      <h2>Share this document</h2>
      {doc.adminUrl && (
        <CopyRow
          label="Admin"
          description={
            "Full control \u2014 can edit, publish," +
            " and manage access"
          }
          value={doc.adminUrl}
        />
      )}
      {doc.writeUrl && (
        <CopyRow
          label="Write"
          description={
            "Can edit the document and publish" +
            " snapshots"
          }
          value={doc.writeUrl}
        />
      )}
      <CopyRow
        label="Read"
        description="View only \u2014 cannot make changes"
        value={doc.readUrl}
      />
      {(isAdmin || canWrite) && (
        <InviteButton doc={doc} />
      )}
    </div>
  );
}
