/**
 * Landing Page pattern — imports the real Landing
 * component. Shows the create/open form and recent
 * documents list rendered from localStorage.
 *
 * Note: "Create" and "Open" buttons attempt to load
 * the P2P stack, which will fail in Storybook.
 * The story is useful for visual/layout testing only.
 */

import type { Meta, StoryObj } from "@storybook/react";
import { Landing } from "../Landing";

const noop = () => {};

const meta: Meta<typeof Landing> = {
  title: "Patterns/Landing Page",
  component: Landing,
  args: {
    onDoc: noop,
  },
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
