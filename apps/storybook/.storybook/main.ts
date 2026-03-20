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
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  viteFinal(config) {
    config.resolve ??= {};
    config.resolve.alias = {
      // CSS subpath export needs its own alias
      // since the index.ts alias swallows it.
      "@pokapali/react/comments.css": path.resolve(
        __dirname,
        "../../../packages/react/src/comments.css",
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
