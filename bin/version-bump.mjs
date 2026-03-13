#!/usr/bin/env node

// Per-package version bump with transitive cascade.
//
// Usage:
//   bin/version-bump.mjs <package> <version>
//   bin/version-bump.mjs --all <version>
//
// Examples:
//   bin/version-bump.mjs @pokapali/crypto 0.1.0-alpha.1
//   bin/version-bump.mjs crypto 0.1.0-alpha.1
//   bin/version-bump.mjs --all 0.1.0-alpha.0
//
// When bumping a single package, all transitive dependents
// are also bumped to the same version. Inter-package
// dependency versions are updated to match.
//
// --all bumps every publishable package to the same version
// (useful for initial release).
//
// Creates per-package git tags (e.g. @pokapali/core@0.1.0)
// that trigger the publish workflow.
//
// Rule: version bumps must be single commits on main.

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const rootDir = join(
  import.meta.dirname ?? new URL(".", import.meta.url).pathname,
  ".."
);
const packagesDir = join(rootDir, "packages");

function run(cmd) {
  return execSync(cmd, {
    cwd: rootDir,
    encoding: "utf8",
  }).trim();
}

// --- preconditions ---

const branch = run("git rev-parse --abbrev-ref HEAD");
if (branch !== "main") {
  console.error(
    `Error: version bumps must be on main`
    + ` (current: ${branch})`
  );
  process.exit(1);
}

try {
  run("git diff --quiet");
  run("git diff --cached --quiet");
} catch {
  console.error("Error: working tree must be clean");
  process.exit(1);
}

// --- helpers ---

function readPkg(dir) {
  const path = join(packagesDir, dir, "package.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

function writePkg(dir, pkg) {
  const path = join(packagesDir, dir, "package.json");
  writeFileSync(
    path,
    JSON.stringify(pkg, null, 2) + "\n"
  );
}

function isPublishable(pkg) {
  return !pkg.private;
}

// --- load all publishable packages ---

const dirs = readdirSync(packagesDir, {
  withFileTypes: true,
})
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

// Map: package name → { dir, pkg }
const packages = new Map();
for (const dir of dirs) {
  try {
    const pkg = readPkg(dir);
    if (isPublishable(pkg)) {
      packages.set(pkg.name, { dir, pkg });
    }
  } catch {
    // skip directories without package.json
  }
}

// --- build dependency graph ---

const deps = new Map();
const reverseDeps = new Map();

for (const [name] of packages) {
  deps.set(name, new Set());
  reverseDeps.set(name, new Set());
}

for (const [name, { pkg }] of packages) {
  for (const depName of Object.keys(
    pkg.dependencies || {}
  )) {
    if (packages.has(depName)) {
      deps.get(name).add(depName);
      reverseDeps.get(depName).add(name);
    }
  }
}

// --- transitive dependents ---

function transitiveDependents(name) {
  const result = new Set();
  const queue = [name];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const dep of reverseDeps.get(current) || []) {
      if (!result.has(dep)) {
        result.add(dep);
        queue.push(dep);
      }
    }
  }
  return result;
}

// --- parse args ---

const args = process.argv.slice(2);

if (args.length !== 2) {
  console.error(
    "Usage: bin/version-bump.mjs <package> <version>\n"
    + "       bin/version-bump.mjs --all <version>"
  );
  process.exit(1);
}

const [target, version] = args;

// Basic semver sanity check
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(
    `Error: "${version}" doesn't look like a version`
  );
  process.exit(1);
}

// --- determine which packages to bump ---

let toBump;

if (target === "--all") {
  toBump = new Set(packages.keys());
} else {
  // Accept short name (e.g. "crypto") or full name
  let resolved = target;
  if (!target.startsWith("@")) {
    resolved = `@pokapali/${target}`;
  }
  if (!packages.has(resolved)) {
    console.error(
      `Error: unknown package "${resolved}"`
    );
    console.error(
      "Available:",
      [...packages.keys()].join(", ")
    );
    process.exit(1);
  }
  toBump = new Set([
    resolved,
    ...transitiveDependents(resolved),
  ]);
}

// --- apply version bumps ---

for (const name of toBump) {
  const { dir, pkg } = packages.get(name);
  const old = pkg.version;
  pkg.version = version;

  // Update internal dependency versions
  for (const depName of Object.keys(
    pkg.dependencies || {}
  )) {
    if (packages.has(depName) && toBump.has(depName)) {
      pkg.dependencies[depName] = version;
    }
  }

  writePkg(dir, pkg);
  if (old !== version) {
    console.log(`  ${name}: ${old} → ${version}`);
  }
}

console.log(
  `\nBumped ${toBump.size} package(s) to ${version}`
);

// --- update dep references in private consumers ---

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

const consumerDirs = [
  ...readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(packagesDir, d.name)),
  ...(() => {
    const appsDir = join(rootDir, "apps");
    try {
      return readdirSync(appsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(appsDir, d.name));
    } catch {
      return [];
    }
  })(),
];

let consumersUpdated = 0;
for (const dir of consumerDirs) {
  const pkgPath = join(dir, "package.json");
  let pkg;
  try {
    pkg = readJson(pkgPath);
  } catch {
    continue;
  }
  if (!pkg.private) continue;
  let changed = false;
  for (const depName of Object.keys(
    pkg.dependencies || {}
  )) {
    if (toBump.has(depName)) {
      pkg.dependencies[depName] = version;
      changed = true;
    }
  }
  if (changed) {
    writeJson(pkgPath, pkg);
    consumersUpdated++;
    console.log(`  updated deps in ${pkg.name}`);
  }
}

if (consumersUpdated > 0) {
  console.log(
    `Updated ${consumersUpdated} private consumer(s)`
  );
}

// --- sync lockfile, commit, and tag ---

console.log("\nRunning npm install to sync lockfile...");
execSync("npm install --ignore-scripts", {
  cwd: rootDir,
  stdio: "inherit",
});

console.log("Creating commit...");
run(
  "git add packages/*/package.json"
  + " apps/*/package.json package-lock.json"
);

const bumped = [...toBump]
  .map((name) => packages.get(name).dir)
  .join(", ");

run(
  `git commit -m "chore: bump ${bumped} to ${version}"`
);

// Create per-package tags for publish workflow
const tags = [...toBump].map(
  (name) => `${name}@${version}`
);
for (const tag of tags) {
  run(`git tag "${tag}"`);
  console.log(`  tagged ${tag}`);
}

console.log(
  `\nDone. Review with: git log -1 --stat`
);
console.log(
  `Push with: git push origin main ${tags.map((t) => `"${t}"`).join(" ")}`
);
