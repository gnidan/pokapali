# Logging Consolidation Design

## 1. Current State

### Where logging exists

8 files across 4 packages log. The other 4 packages
(crypto, capability, snapshot, subdocs) have no logging.

| Package | Module | Abstraction | Prefix | Output |
|---------|--------|-------------|--------|--------|
| node | relay.ts | `const log` | `[pokapali:relay]` | stderr |
| node | pinner.ts | `const log` | `[pokapali:pinner]` | stderr |
| node | bin/node.ts | none | none | stderr |
| node | http.ts | none | none | stderr |
| core | index.ts | none | `[pokapali]` | mixed |
| core | ipns-helpers.ts | none | `[pokapali]` | mixed |
| core | peer-discovery.ts | `const log` | `[pokapali:discovery]` | stdout |
| sync | gossipsub-signaling.ts | `const log` | `[pokapali:gossipsub]` | stdout |

~95 log call sites total.

### Inconsistencies

1. **Two prefix styles**: Abstracted modules use
   `[pokapali:module]`. Core modules use bare
   `[pokapali]` with no submodule name.

2. **Inconsistent output channels**: Node-side code
   (relay, pinner) logs to `console.error` (stderr).
   Browser-capable code (core, sync) uses
   `console.log` (stdout). Core's ipns-helpers uses
   all three: log, warn, error.

3. **No log levels**: Everything is either "log it or
   don't." No way to enable debug output without
   editing source. No way to suppress noisy info-level
   messages in production.

4. **No structured output**: All messages are
   human-readable text. Journalctl captures them fine,
   but grepping/parsing is fragile.

5. **Half use the abstraction, half don't**: The
   `const log = (...args) => console.error(...)` pattern
   appears in 4 files. The other 4 call console directly
   with inline prefixes.

## 2. Proposed Unified Approach

### Design: Minimal `createLogger(module)` factory

No external dependency. A single shared module that
returns a logger with standard levels. ~40 lines.

```ts
// packages/log/src/index.ts

type LogLevel = "debug" | "info" | "warn" | "error";

interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const LEVEL_ORDER: LogLevel[] = [
  "debug", "info", "warn", "error",
];

let globalLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

export function createLogger(module: string): Logger {
  const prefix = `[pokapali:${module}]`;

  function shouldLog(level: LogLevel): boolean {
    return (
      LEVEL_ORDER.indexOf(level)
      >= LEVEL_ORDER.indexOf(globalLevel)
    );
  }

  return {
    debug(...args) {
      if (shouldLog("debug"))
        console.debug(prefix, ...args);
    },
    info(...args) {
      if (shouldLog("info"))
        console.log(prefix, ...args);
    },
    warn(...args) {
      if (shouldLog("warn"))
        console.warn(prefix, ...args);
    },
    error(...args) {
      if (shouldLog("error"))
        console.error(prefix, ...args);
    },
  };
}
```

### Key decisions

**Console methods, not stderr/stdout directly.**
`console.error` → stderr, `console.warn` → stderr,
`console.log` → stdout, `console.debug` → stdout.
This works in both Node (journalctl captures both)
and browsers (devtools filters by level). No special
handling needed per environment.

**Level filtering via `setLogLevel()`.** Default
`"info"` suppresses debug. Also reads
`POKAPALI_LOG_LEVEL` env var on init (useful for
systemd `Environment=` without changing ExecStart).
Browser code can call `setLogLevel("debug")` from
devtools.

**Consistent prefix format**: All modules become
`[pokapali:module]` — e.g., `[pokapali:relay]`,
`[pokapali:ipns]`, `[pokapali:discovery]`,
`[pokapali:gossipsub]`, `[pokapali:core]`.

**No structured JSON output (yet).** Structured
logging (JSON per line) is useful for log aggregation
services, but we don't run any. Journalctl + grep is
sufficient at our scale. If needed later, we swap the
implementation inside `createLogger` without changing
call sites.

## 3. Why Not a Dependency

| Library | Bundle (min) | Notes |
|---------|-------------|-------|
| pino | 15 KB | Node-focused, no native browser |
| winston | 50+ KB | Heavy, Node-only |
| loglevel | 2 KB | Closest fit but still unnecessary |
| debug | 3 KB | Env-var filtering only, no levels |

Our needs are simple: prefix + level filtering. The
factory above is ~40 lines, zero dependencies, works
in both Node and browser, and is trivially testable.
Adding a dependency would:

- Increase bundle size in browser builds
- Require browser/node conditional imports or shims
- Add configuration surface we don't need

If we later need structured JSON output, rotating
log files, or transport to external services, we can
revisit. But those are ops concerns for the `node`
package specifically, not a monorepo-wide need.

## 4. Node vs Browser Considerations

### Node (packages/node)

- Runs under systemd; journalctl captures stderr +
  stdout automatically
- Current convention: all output to stderr via
  `console.error`. This is fine but inconsistent with
  the log level concept
- With the proposed approach: `console.log` (info)
  goes to stdout, `console.error`/`console.warn` go
  to stderr. Journalctl captures both. No behavior
  change for systemd
- The CLI entry point (`bin/node.ts`) should use
  `info` for startup messages, `error` for fatal
  errors — same as today, just formalized
- `--log-level` CLI flag controls verbosity

### Browser (packages/core, sync)

- `console.log/warn/error/debug` map directly to
  browser devtools levels with filtering UI
- `setLogLevel("debug")` can be called from devtools
  console for troubleshooting
- No bundle impact: the factory is tiny inline code,
  not an external module
- Vite tree-shakes unused log levels in production
  builds (dead code after minification)

### Shared packages (crypto, capability, etc.)

- Currently have no logging. Keep it that way —
  these are pure-function libraries
- If logging is ever needed (unlikely), import
  `createLogger` from core

## 5. Migration Path

### Where to put the logger

**New `@pokapali/log` package** — leaf package with
zero dependencies, like `@pokapali/crypto`. Required
because `@pokapali/sync` doesn't depend on core, so
putting the logger in core would create a dependency
issue.

### Incremental steps

Each step is a single commit, independently
deployable:

**Step 1: Create `@pokapali/log` package.**
New package with `createLogger`, `setLogLevel`,
`getLogLevel`. Reads `POKAPALI_LOG_LEVEL` env var
on init. Add tests for level filtering.

**Step 2: Migrate `@pokapali/sync`.**
Replace gossipsub-signaling.ts logger. Simplest
consumer — validates the package works. Add
`@pokapali/log` dependency.

**Step 3: Migrate `@pokapali/node` (relay, pinner).**
Replace `const log = (...args) => console.error(...)`
with `createLogger("relay")` / `createLogger("pinner")`.
Map current `log(...)` calls to appropriate levels:
- Startup/shutdown messages → `info`
- Periodic status → `debug`
- Operation results → `info`
- Failures → `error` or `warn`
Add `--log-level` CLI flag. Expose log level in
`/status` endpoint.

**Step 4: Migrate `@pokapali/core`.**
Replace inline `console.log("[pokapali]", ...)` in
index.ts and ipns-helpers.ts with
`createLogger("core")` / `createLogger("ipns")`.
Map console.warn → warn, console.error → error,
console.log → info or debug as appropriate.

**Step 5: Migrate `@pokapali/core` peer-discovery.**
Same pattern.

### Level assignment guide

| Current usage | Proposed level |
|--------------|---------------|
| Startup/shutdown, config | info |
| Periodic status dumps | debug |
| Successful operations (provide OK, IPNS published) | debug |
| Retries, fallbacks | warn |
| Failures, rejected blocks | error |
| Diagnostic mesh/peer details | debug |
| Connection lifecycle | debug |

### Estimated scope

- ~95 call sites to update
- 5 commits, each independently testable
- Step 1 is zero-risk (additive only)
- Steps 2-5 are mechanical find-and-replace with
  level assignment
- No behavioral change except debug messages become
  suppressible (they're `info` today)

## Resolved Questions

1. **Log level in /status endpoint?** Yes — one
   field, useful for remote diagnosis.

2. **Environment variable?** Yes —
   `POKAPALI_LOG_LEVEL` read on module init. Useful
   for systemd `Environment=` without changing
   ExecStart.

## Open Questions

1. **Per-module level filtering?** E.g., only enable
   debug for `relay` but keep `pinner` at `info`.
   Probably overkill now, but the `debug` library
   pattern (`DEBUG=pokapali:relay*`) is well-known.
   Could add later if needed.
