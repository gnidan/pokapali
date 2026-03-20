/**
 * Smoke test story — verifies Storybook can
 * resolve @pokapali/* workspace aliases and
 * render a basic React component.
 *
 * Replace with real component stories once
 * product provides story guidance.
 */

import type { Meta, StoryObj } from "@storybook/react";

function Smoke() {
  return (
    <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h2>Storybook is working</h2>
      <p>Workspace aliases resolve correctly. Ready for component stories.</p>
    </div>
  );
}

const meta: Meta<typeof Smoke> = {
  title: "Smoke Test",
  component: Smoke,
};

export default meta;
type Story = StoryObj<typeof Smoke>;

export const Default: Story = {};
