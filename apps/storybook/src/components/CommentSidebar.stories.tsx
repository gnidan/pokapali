import type { Meta, StoryObj } from "@storybook/react";
import { CommentSidebar } from "@pokapali/react";
import {
  threadedComments,
  resolvedComments,
  orphanedComment,
  anchorPositions,
  baseCommentProps,
  SidebarFrame,
} from "../helpers/mock-comment-data";

const meta: Meta<typeof CommentSidebar> = {
  title: "Components/CommentSidebar",
  component: CommentSidebar,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const WithThreads: Story = {
  render: () => (
    <SidebarFrame>
      <CommentSidebar
        {...baseCommentProps}
        comments={threadedComments}
        anchorPositions={anchorPositions}
      />
    </SidebarFrame>
  ),
};

export const Empty: Story = {
  render: () => (
    <SidebarFrame>
      <CommentSidebar
        {...baseCommentProps}
        comments={[]}
        anchorPositions={new Map()}
      />
    </SidebarFrame>
  ),
};

export const Offline: Story = {
  render: () => (
    <SidebarFrame>
      <CommentSidebar
        {...baseCommentProps}
        comments={threadedComments}
        anchorPositions={anchorPositions}
        status="offline"
      />
    </SidebarFrame>
  ),
};

export const Connecting: Story = {
  render: () => (
    <SidebarFrame>
      <CommentSidebar
        {...baseCommentProps}
        comments={threadedComments}
        anchorPositions={anchorPositions}
        status="connecting"
      />
    </SidebarFrame>
  ),
};

export const Resolved: Story = {
  render: () => (
    <SidebarFrame>
      <CommentSidebar
        {...baseCommentProps}
        comments={resolvedComments}
        anchorPositions={new Map()}
      />
    </SidebarFrame>
  ),
};

export const OrphanedAnchor: Story = {
  render: () => (
    <SidebarFrame>
      <CommentSidebar
        {...baseCommentProps}
        comments={orphanedComment}
        anchorPositions={new Map()}
      />
    </SidebarFrame>
  ),
};

export const PendingAnchor: Story = {
  render: () => (
    <SidebarFrame>
      <CommentSidebar
        {...baseCommentProps}
        comments={threadedComments}
        anchorPositions={anchorPositions}
        hasPendingAnchor={true}
      />
    </SidebarFrame>
  ),
};
