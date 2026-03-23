import type { Meta, StoryObj } from "@storybook/react";
import { ValidationWarning } from "./ValidationWarning";

const meta: Meta<typeof ValidationWarning> = {
  title: "Components/ValidationWarning",
  component: ValidationWarning,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const LongCid: Story = {
  args: {
    error: {
      cid: "bafyreih5g7wxmq3a4k2vpe6e7lzqxbh4ndrs2oa3f5wkymjnqv7kzpxmy",
      message: "A received update was rejected (invalid signature)",
    },
  },
};

export const ShortCid: Story = {
  args: {
    error: {
      cid: "bafyreih5g7wxm",
      message: "A received update was rejected (invalid signature)",
    },
  },
};

export const NoError: Story = {
  args: {
    error: null,
  },
};
