/**
 * CommentPopover stories — the floating comment
 * button that appears on text selection.
 *
 * Since CommentPopover relies on browser selection
 * APIs, these stories render an editable text area
 * for manual interaction. The popover appears when
 * text is selected inside the editor element.
 */

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { CommentPopover } from "./comment-popover.js";

// ── Editor mock ─────────────────────────────────

function MockEditor({
  children,
  readOnly,
}: {
  children?: React.ReactNode;
  readOnly?: boolean;
}) {
  return (
    <div
      style={{
        padding: "2rem",
        fontFamily: "Georgia, serif",
        lineHeight: 1.6,
        maxWidth: 600,
      }}
    >
      <div
        className="ProseMirror"
        contentEditable={!readOnly}
        suppressContentEditableWarning
        style={{
          padding: "1rem",
          border: "1px solid #e2e8f0",
          borderRadius: 6,
          minHeight: 200,
          outline: "none",
        }}
      >
        <p>
          The project proposal outlines a phased approach to modernizing our
          documentation system. In the first phase, we will migrate existing
          content to the new platform while preserving all revision history.
        </p>
        <p>
          Phase two focuses on collaborative editing features, allowing multiple
          team members to work on the same document simultaneously. Comments and
          suggestions will be anchored to specific text selections.
        </p>
        <p>
          The final phase introduces automated quality checks and a review
          workflow that integrates with our existing project management tools.
        </p>
      </div>
      {children}
    </div>
  );
}

// ── Meta ────────────────────────────────────────

const meta: Meta<typeof CommentPopover> = {
  component: CommentPopover,
};

export default meta;
type Story = StoryObj<typeof CommentPopover>;

// ── Stories ─────────────────────────────────────

export const TextSelected: Story = {
  name: "Comments/Commenting/Selecting Text",
  render: () => {
    const [lastAction, setLastAction] = useState("");
    return (
      <MockEditor>
        <CommentPopover onComment={() => setLastAction("Comment added!")} />
        <p
          style={{
            fontSize: "0.8rem",
            color: "#64748b",
            marginTop: "1rem",
          }}
        >
          Select any text above to see the comment button.
          {lastAction && <strong> {lastAction}</strong>}
        </p>
      </MockEditor>
    );
  },
};

export const NoSelection: Story = {
  name: "Comments/Commenting/No Selection",
  render: () => (
    <MockEditor>
      <CommentPopover onComment={() => {}} />
      <p
        style={{
          fontSize: "0.8rem",
          color: "#64748b",
          marginTop: "1rem",
        }}
      >
        No text is selected — the comment button is hidden.
      </p>
    </MockEditor>
  ),
};

export const ReadOnlyUser: Story = {
  name: "Comments/Commenting/Read-Only User",
  render: () => (
    <MockEditor readOnly>
      <p
        style={{
          fontSize: "0.8rem",
          color: "#64748b",
          marginTop: "1rem",
        }}
      >
        This document is read-only. Select text — no comment button appears.
      </p>
    </MockEditor>
  ),
};
