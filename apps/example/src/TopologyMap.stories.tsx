import type { Meta, StoryObj } from "@storybook/react";
import { TopologyMap } from "@pokapali/react/topology";
import {
  createMockTopologyDoc,
  healthyGraph,
  degradedGraph,
  soloGraph,
} from "./mock-topology-doc";

const meta: Meta<typeof TopologyMap> = {
  title: "Components/TopologyMap",
  component: TopologyMap,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Healthy: Story = {
  render: () => (
    <div style={{ overflow: "hidden" }}>
      <TopologyMap doc={createMockTopologyDoc(healthyGraph)} />
    </div>
  ),
};

export const Degraded: Story = {
  render: () => (
    <div style={{ overflow: "hidden" }}>
      <TopologyMap doc={createMockTopologyDoc(degradedGraph)} />
    </div>
  ),
};

export const Solo: Story = {
  render: () => (
    <div style={{ overflow: "hidden" }}>
      <TopologyMap doc={createMockTopologyDoc(soloGraph)} />
    </div>
  ),
};

export const ReadOnly: Story = {
  render: () => (
    <div style={{ overflow: "hidden" }}>
      <TopologyMap
        doc={createMockTopologyDoc(healthyGraph, {
          canPushSnapshots: false,
        })}
      />
    </div>
  ),
};
