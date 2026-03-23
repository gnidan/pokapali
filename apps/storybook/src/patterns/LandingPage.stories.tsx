import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Badge, LockIcon, relativeAge } from "../helpers/story-helpers";

/**
 * Landing Page pattern — the create/open form and
 * recent documents list shown before a document is
 * opened. Demonstrates the entry flow into the
 * editor.
 */

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface RecentDoc {
  title: string;
  url: string;
  role: "admin" | "writer" | "reader";
  lastOpened: number;
}

const recentDocs: RecentDoc[] = [
  {
    title: "Project Roadmap",
    url: "#/doc/bafyreih5g7wxmq3a",
    role: "admin",
    lastOpened: NOW - 2 * HOUR,
  },
  {
    title: "Meeting Notes — March 20",
    url: "#/doc/bafyreig8k2pxnq4b",
    role: "writer",
    lastOpened: NOW - DAY,
  },
  {
    title: "API Reference v2",
    url: "#/doc/bafyreif3j9mwrl5c",
    role: "reader",
    lastOpened: NOW - 3 * DAY,
  },
  {
    title: "Sprint Retro",
    url: "#/doc/bafyreid7h4nxso6d",
    role: "writer",
    lastOpened: NOW - 5 * DAY,
  },
];

function LandingPagePatterns() {
  const [openUrl, setOpenUrl] = useState("");

  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        gap: "2rem",
        maxWidth: 560,
      }}
    >
      <h2 style={{ marginBottom: "0.5rem" }}>Landing Page</h2>
      <p
        style={{
          fontSize: "var(--poka-text-sm)",
          color: "var(--poka-text-muted)",
          marginBottom: "0.5rem",
        }}
      >
        Entry point before a document is opened. Users can create a new
        document, paste a share link, or pick from recent documents.
        Demonstrates the E2E encryption messaging and capability-URL model.
      </p>

      {/* Hero / Create section */}
      <div
        style={{
          background: "var(--poka-bg-surface)",
          border: "1px solid var(--poka-border-default)",
          borderRadius: "var(--poka-radius-lg)",
          padding: "var(--poka-space-4)",
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontSize: "var(--poka-text-lg)",
            fontWeight: "var(--poka-weight-bold)" as unknown as number,
            color: "var(--poka-text-primary)",
            marginBottom: "var(--poka-space-1)",
          }}
        >
          Pokapali
        </div>
        <div
          style={{
            fontSize: "var(--poka-text-sm)",
            color: "var(--poka-text-muted)",
            marginBottom: "var(--poka-space-4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "var(--poka-space-1)",
          }}
        >
          <LockIcon size={12} />
          Encrypted, peer-to-peer collaborative editing
        </div>

        <button
          style={{
            fontSize: "var(--poka-text-sm)",
            fontWeight: "var(--poka-weight-semibold)" as unknown as number,
            padding: "8px 24px",
            borderRadius: "var(--poka-radius-md)",
            border: "none",
            background: "var(--poka-color-accent)",
            color: "#ffffff",
            cursor: "pointer",
            marginBottom: "var(--poka-space-4)",
          }}
        >
          Create new document
        </button>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--poka-space-2)",
          }}
        >
          <span
            style={{
              flex: 1,
              height: 1,
              background: "var(--poka-border-default)",
            }}
          />
          <span
            style={{
              fontSize: "var(--poka-text-2xs)",
              color: "var(--poka-text-muted)",
            }}
          >
            or open an existing document
          </span>
          <span
            style={{
              flex: 1,
              height: 1,
              background: "var(--poka-border-default)",
            }}
          />
        </div>

        <div
          style={{
            display: "flex",
            gap: "var(--poka-space-2)",
            marginTop: "var(--poka-space-3)",
          }}
        >
          <input
            type="text"
            placeholder="Paste a share link..."
            value={openUrl}
            onChange={(e) => setOpenUrl(e.target.value)}
            style={{
              flex: 1,
              fontSize: "var(--poka-text-xs)",
              padding: "6px 10px",
              border: "1px solid " + "var(--poka-border-default)",
              borderRadius: "var(--poka-radius-sm)",
              background: "var(--poka-bg-surface)",
              color: "var(--poka-text-primary)",
            }}
          />
          <button
            style={{
              fontSize: "var(--poka-text-xs)",
              fontWeight: "var(--poka-weight-medium)" as unknown as number,
              padding: "6px 14px",
              borderRadius: "var(--poka-radius-sm)",
              border: "1px solid " + "var(--poka-color-accent)",
              background: "transparent",
              color: "var(--poka-color-accent)",
              cursor: "pointer",
            }}
          >
            Open
          </button>
        </div>
      </div>

      {/* Recent documents */}
      <div>
        <h3
          style={{
            fontSize: "var(--poka-text-sm)",
            fontWeight: "var(--poka-weight-semibold)" as unknown as number,
            color: "var(--poka-text-primary)",
            marginBottom: "var(--poka-space-2)",
          }}
        >
          Recent documents
        </h3>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            border: "1px solid " + "var(--poka-border-default)",
            borderRadius: "var(--poka-radius-lg)",
            overflow: "hidden",
          }}
        >
          {recentDocs.map((doc, i) => (
            <div
              key={doc.url}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--poka-space-3)",
                padding: "var(--poka-space-3) " + "var(--poka-space-4)",
                background: "var(--poka-bg-surface)",
                borderTop:
                  i > 0 ? "1px solid " + "var(--poka-border-default)" : "none",
                cursor: "pointer",
              }}
            >
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    fontSize: "var(--poka-text-sm)",
                    fontWeight:
                      "var(--poka-weight-medium)" as unknown as number,
                    color: "var(--poka-text-primary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {doc.title}
                </div>
                <div
                  style={{
                    fontSize: "var(--poka-text-2xs)",
                    color: "var(--poka-text-muted)",
                    marginTop: 2,
                  }}
                >
                  Opened {relativeAge(doc.lastOpened)}
                </div>
              </div>
              <Badge role={doc.role} />
              <span
                style={{
                  fontSize: "var(--poka-text-sm)",
                  color: "var(--poka-text-muted)",
                }}
              >
                &#8594;
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Empty state */}
      <div>
        <code
          style={{
            fontSize: "var(--poka-text-2xs)",
            color: "var(--poka-text-muted)",
            display: "block",
            marginBottom: "0.5rem",
          }}
        >
          Empty state — no recent documents
        </code>
        <div
          style={{
            padding: "var(--poka-space-4)",
            background: "var(--poka-bg-surface)",
            border: "1px solid " + "var(--poka-border-default)",
            borderRadius: "var(--poka-radius-lg)",
            textAlign: "center",
            fontSize: "var(--poka-text-sm)",
            color: "var(--poka-text-muted)",
          }}
        >
          No recent documents. Create a new one or paste a share link above.
        </div>
      </div>
    </div>
  );
}

const meta: Meta<typeof LandingPagePatterns> = {
  title: "Patterns/Landing Page",
  component: LandingPagePatterns,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
