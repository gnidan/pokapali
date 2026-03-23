import type { Preview } from "@storybook/react";
import "@pokapali/react/tokens.css";
import "@pokapali/react/comments.css";
import "@pokapali/react/indicators.css";
import "@pokapali/react/topology-map.css";
import "../../example/src/styles.css";

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /date$/i,
      },
    },
  },
};

export default preview;
