import type { Meta, StoryObj } from "@storybook/react";
import type { Doc } from "@pokapali/core";
import { SharePanel } from "./SharePanel";

const base = "https://app.pokapali.dev/#/doc/bafyreih5g7wxmq3a";

function mockDoc(role: "admin" | "writer" | "reader"): Doc {
  const urls: Record<string, string> = {
    read: base + "?cap=read_key_def456",
  };
  if (role === "admin" || role === "writer") {
    urls.write = base + "?cap=write_key_xyz789";
  }
  if (role === "admin") {
    urls.admin = base + "?cap=admin_key_abc123";
  }
  return { urls } as unknown as Doc;
}

const meta: Meta<typeof SharePanel> = {
  title: "Components/SharePanel",
  component: SharePanel,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Admin: Story = {
  render: () => <SharePanel doc={mockDoc("admin")} />,
};

export const Writer: Story = {
  render: () => <SharePanel doc={mockDoc("writer")} />,
};

export const Reader: Story = {
  render: () => <SharePanel doc={mockDoc("reader")} />,
};
