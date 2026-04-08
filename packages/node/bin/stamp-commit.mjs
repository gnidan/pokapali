import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const target = join(dir, "..", "src", "build-info.ts");

let commit;
try {
  commit = execSync("git rev-parse HEAD", {
    encoding: "utf8",
    timeout: 5000,
  }).trim();
} catch {
  commit = undefined;
}

const value = commit === undefined ? "undefined" : `"${commit}"`;

const content = [
  "// Generated at build time — do not edit.",
  "export const BUILD_COMMIT: string | undefined =",
  `  ${value};`,
  "",
].join("\n");

writeFileSync(target, content);
