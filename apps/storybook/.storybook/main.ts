import type { StorybookConfig } from "@storybook/react-vite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const localPkgs = [
  "comments",
  "comments-tiptap",
  "core",
  "crypto",
  "capability",
  "log",
  "react",
  "subdocs",
  "snapshot",
  "sync",
];

const config: StorybookConfig = {
  stories: [
    "../src/**/*.stories.@(ts|tsx)",
    "../../../packages/react/src/**/*.stories.@(ts|tsx)",
    "../../../apps/example/src/**/*.stories.@(ts|tsx)",
  ],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  viteFinal(config) {
    config.resolve ??= {};
    config.resolve.alias = {
      // CSS subpath export needs its own alias
      // since the index.ts alias swallows it.
      "@pokapali/react/tokens.css": path.resolve(
        __dirname,
        "../../../packages/react/src/tokens.css",
      ),
      "@pokapali/react/comments.css": path.resolve(
        __dirname,
        "../../../packages/react/src/comments.css",
      ),
      "@pokapali/react/indicators.css": path.resolve(
        __dirname,
        "../../../packages/react/src/indicators.css",
      ),
      "@pokapali/react/topology-map.css": path.resolve(
        __dirname,
        "../../../packages/react/src/topology-map.css",
      ),
      "@pokapali/react/topology": path.resolve(
        __dirname,
        "../../../packages/react/src/topology.ts",
      ),
      ...Object.fromEntries(
        localPkgs.map((p) => [
          `@pokapali/${p}`,
          path.resolve(__dirname, `../../../packages/${p}/src/index.ts`),
        ]),
      ),
    };
    return config;
  },
};

export default config;
