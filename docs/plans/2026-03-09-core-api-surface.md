# Core API Surface Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use
> superpowers:executing-plans to implement this plan
> task-by-task.

**Goal:** Move app-layer logic (diagnostics, URL
utilities, readiness) into `@pokapali/core` so consumers
don't reach into Helia internals or duplicate URL parsing.

**Architecture:** Four independent additions to
`packages/core/src/index.ts` and its public interface.
Each is a pure addition — no existing behavior changes.
`diagnostics()` replaces `as any` Helia access in the
example app. `truncateUrl` and `docIdFromUrl` centralize
URL knowledge. `doc.ready` exposes a promise for first
meaningful state.

**Tech Stack:** TypeScript, Vitest, Yjs, libp2p/Helia
(internals accessed only inside core)

---

## Task 1: `CollabDoc.diagnostics()` method

Move `gatherInfo()` from `ConnectionStatus.tsx` into core.
This eliminates `as any` casts and `getHelia()` imports
from the example app.

**Files:**

- Modify: `packages/core/src/index.ts` (interface + impl)
- Test: `packages/core/src/index.test.ts`

### Step 1: Define the `DiagnosticsInfo` type and add

`diagnostics()` to the `CollabDoc` interface

Add to `packages/core/src/index.ts`, after the
`RotateResult` interface (~line 110):

```typescript
export interface RelayDiagnostic {
  peerId: string;
  short: string;
  connected: boolean;
}

export interface GossipSubDiagnostic {
  peers: number;
  topics: number;
  meshPeers: number;
}

export interface DiagnosticsInfo {
  ipfsPeers: number;
  relays: RelayDiagnostic[];
  editors: number;
  gossipsub: GossipSubDiagnostic;
  clockSum: number;
  maxPeerClockSum: number;
  latestAnnouncedSeq: number;
  ipnsSeq: number | null;
  fetchState: SnapshotFetchState;
  hasAppliedSnapshot: boolean;
}
```

Add to the `CollabDoc` interface (~line 163, before
`history()`):

```typescript
  diagnostics(): DiagnosticsInfo;
```

### Step 2: Implement `diagnostics()` in `createCollabDoc`

Add inside the returned object in `createCollabDoc`,
before the `history()` method (~line 719):

```typescript
    diagnostics(): DiagnosticsInfo {
      let ipfsPeers = 0;
      const relayList: RelayDiagnostic[] = [];
      let gossipsub: GossipSubDiagnostic = {
        peers: 0,
        topics: 0,
        meshPeers: 0,
      };

      try {
        const helia = getHelia();
        const libp2p = (helia as any).libp2p;
        ipfsPeers = libp2p.getPeers().length;

        const knownRelays =
          params.roomDiscovery?.relayPeerIds
            ?? new Set<string>();
        if (knownRelays.size > 0) {
          const connectedPids = new Set<string>();
          for (const conn of libp2p.getConnections()) {
            connectedPids.add(
              (conn as any).remotePeer.toString(),
            );
          }
          for (const pid of knownRelays) {
            relayList.push({
              peerId: pid,
              short: pid.slice(-8),
              connected: connectedPids.has(pid),
            });
          }
        }

        try {
          const pubsub = libp2p.services.pubsub;
          const topics: string[] =
            pubsub.getTopics?.() ?? [];
          const gsPeers = pubsub.getPeers?.() ?? [];
          const mesh = (pubsub as any).mesh as
            | Map<string, Set<string>>
            | undefined;
          let meshPeers = 0;
          if (mesh) {
            for (const set of mesh.values()) {
              meshPeers += set.size;
            }
          }
          gossipsub = {
            peers: gsPeers.length,
            topics: topics.length,
            meshPeers,
          };
        } catch {}
      } catch {
        // Helia not ready
      }

      let maxPeerClockSum = 0;
      let editors = 1;
      try {
        const states =
          awarenessRoom.awareness.getStates();
        editors = Math.max(1, states.size);
        for (const [, state] of states) {
          const cs = (state as any)?.clockSum;
          if (
            typeof cs === "number" &&
            cs > maxPeerClockSum
          ) {
            maxPeerClockSum = cs;
          }
        }
      } catch {}

      return {
        ipfsPeers,
        relays: relayList,
        editors,
        gossipsub,
        clockSum: computeClockSum(),
        maxPeerClockSum,
        latestAnnouncedSeq:
          snapshotWatcher?.latestAnnouncedSeq ?? 0,
        ipnsSeq: snapshotLC.lastIpnsSeq,
        fetchState: snapshotWatcher?.fetchState
          ?? { status: "idle" },
        hasAppliedSnapshot:
          snapshotWatcher?.hasAppliedSnapshot ?? false,
      };
    },
```

### Step 3: Write a basic test

The existing `index.test.ts` may not have integration
tests for this (it likely tests createCollabLib). Add a
unit-level test that verifies the return shape. Since
`diagnostics()` depends on Helia internals, use a
minimal smoke test — the real validation is that the
example app compiles without `as any`.

In `packages/core/src/index.test.ts`, add:

```typescript
describe("CollabDoc.diagnostics", () => {
  it("returns a DiagnosticsInfo object", () => {
    // This test validates the type contract.
    // Full integration test requires Helia setup.
    // The primary validation is that
    // ConnectionStatus.tsx compiles without
    // getHelia() or `as any`.
    const info: DiagnosticsInfo = {
      ipfsPeers: 0,
      relays: [],
      editors: 1,
      gossipsub: {
        peers: 0,
        topics: 0,
        meshPeers: 0,
      },
      clockSum: 0,
      maxPeerClockSum: 0,
      latestAnnouncedSeq: 0,
      ipnsSeq: null,
      fetchState: { status: "idle" },
      hasAppliedSnapshot: false,
    };
    expect(info.ipfsPeers).toBe(0);
  });
});
```

### Step 4: Run tests

Run: `npm test -w packages/core`
Expected: PASS

### Step 5: Commit

```bash
git add packages/core/src/index.ts \
  packages/core/src/index.test.ts
git commit -m "feat(core): add diagnostics() to CollabDoc

Moves gatherInfo() logic from ConnectionStatus.tsx into
core. Returns structured DiagnosticsInfo with ipfsPeers,
relays, editors, gossipsub stats, clock/seq info, and
fetch state. Eliminates the need for app code to access
Helia internals via 'as any'."
```

### Step 6: Note example app simplification

After this commit, `ConnectionStatus.tsx` can:

- Remove the `gatherInfo()` function entirely
- Remove `import { getHelia } from "@pokapali/core"`
- Remove the `ConnectionInfo` / `RelayInfo` /
  `GossipSubInfo` interfaces
- Replace `gatherInfo(doc)` with `doc.diagnostics()`
- Import `DiagnosticsInfo` type from `@pokapali/core`
  if needed for the state type

---

## Task 2: `truncateUrl()` utility

Move URL truncation from `SharePanel.tsx` into core.
Core knows the capability URL structure (long hash
fragments containing encoded key material).

**Files:**

- Create: `packages/core/src/url-utils.ts`
- Create: `packages/core/src/url-utils.test.ts`
- Modify: `packages/core/src/index.ts` (re-export)

### Step 1: Write the failing test

Create `packages/core/src/url-utils.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { truncateUrl } from "./url-utils.js";

describe("truncateUrl", () => {
  it("truncates long hash fragments", () => {
    const url = "http://localhost:3141/doc/abc123" + "#" + "a".repeat(64);
    const result = truncateUrl(url);
    expect(result).toContain("…");
    expect(result).not.toBe(url);
    // Keeps origin + pathname + shortened hash
    expect(result).toContain("http://localhost:3141/doc/abc123#");
  });

  it("preserves short hash fragments", () => {
    const url = "http://localhost:3141/doc/abc123#short";
    expect(truncateUrl(url)).toBe(url);
  });

  it("preserves URLs with no hash", () => {
    const url = "http://localhost:3141/doc/abc123";
    expect(truncateUrl(url)).toBe(url);
  });

  it("returns invalid URLs unchanged", () => {
    expect(truncateUrl("not-a-url")).toBe("not-a-url");
  });
});
```

### Step 2: Run test to verify it fails

Run: `npm test -w packages/core -- url-utils`
Expected: FAIL — module not found

### Step 3: Write the implementation

Create `packages/core/src/url-utils.ts`:

```typescript
/**
 * Truncate a capability URL's hash fragment for
 * display. The fragment contains encoded key material
 * and is typically 100+ characters. This shows the
 * first 8 and last 8 characters with an ellipsis.
 */
export function truncateUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const hash = parsed.hash;
    if (hash.length > 20) {
      return (
        parsed.origin +
        parsed.pathname +
        "#" +
        hash.slice(1, 9) +
        "\u2026" +
        hash.slice(-8)
      );
    }
    return url;
  } catch {
    return url;
  }
}
```

### Step 4: Re-export from index.ts

Add to the bottom of `packages/core/src/index.ts`,
near the other re-exports:

```typescript
export { truncateUrl } from "./url-utils.js";
```

### Step 5: Run tests

Run: `npm test -w packages/core -- url-utils`
Expected: PASS

### Step 6: Commit

```bash
git add packages/core/src/url-utils.ts \
  packages/core/src/url-utils.test.ts \
  packages/core/src/index.ts
git commit -m "feat(core): add truncateUrl() utility

Centralizes capability URL truncation for display.
Shortens long hash fragments (key material) to first 8
and last 8 characters with an ellipsis."
```

### Step 7: Note example app simplification

After this commit, `SharePanel.tsx` can:

- Remove the local `truncateUrl()` function
- Import `truncateUrl` from `@pokapali/core`

---

## Task 3: `collab.docIdFromUrl(url)` on CollabLib

Move IPNS name extraction from `recentDocs.ts` into
CollabLib. Core knows the URL path format (`/doc/<id>`).

**Files:**

- Modify: `packages/core/src/url-utils.ts`
- Modify: `packages/core/src/url-utils.test.ts`
- Modify: `packages/core/src/index.ts` (CollabLib
  interface + impl + re-export)

### Step 1: Write the failing test

Add to `packages/core/src/url-utils.test.ts`:

```typescript
import { docIdFromUrl } from "./url-utils.js";

describe("docIdFromUrl", () => {
  it("extracts and truncates the IPNS name", () => {
    const url =
      "http://localhost:3141/doc/" + "abcdef1234567890abcdef" + "#fragment";
    const result = docIdFromUrl(url);
    // Long IDs are truncated: first 6 + … + last 6
    expect(result).toBe("abcdef\u2026abcdef");
  });

  it("returns short IDs untruncated", () => {
    const url = "http://localhost:3141/doc/shortid#frag";
    expect(docIdFromUrl(url)).toBe("shortid");
  });

  it("returns 'unknown' for non-doc URLs", () => {
    expect(docIdFromUrl("http://localhost:3141/other")).toBe("unknown");
  });

  it("returns 'unknown' for invalid URLs", () => {
    expect(docIdFromUrl("not-a-url")).toBe("unknown");
  });

  it("handles base path before /doc/", () => {
    const url = "http://localhost:3141/app/doc/" + "someid#frag";
    expect(docIdFromUrl(url)).toBe("someid");
  });
});
```

### Step 2: Run test to verify it fails

Run: `npm test -w packages/core -- url-utils`
Expected: FAIL — docIdFromUrl not exported

### Step 3: Implement in url-utils.ts

Add to `packages/core/src/url-utils.ts`:

```typescript
/**
 * Extract a short document ID from a capability URL.
 * The URL path is `<base>/doc/<ipnsName>`. Long IPNS
 * names (>12 chars) are truncated for display.
 */
export function docIdFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/");
    const docIdx = parts.indexOf("doc");
    if (docIdx >= 0 && parts[docIdx + 1]) {
      const id = parts[docIdx + 1];
      return id.length > 12 ? id.slice(0, 6) + "\u2026" + id.slice(-6) : id;
    }
  } catch {}
  return "unknown";
}
```

### Step 4: Add to CollabLib interface and re-export

In `packages/core/src/index.ts`, add `docIdFromUrl` to
the `CollabLib` interface:

```typescript
export interface CollabLib {
  create(): Promise<CollabDoc>;
  open(url: string): Promise<CollabDoc>;
  docIdFromUrl(url: string): string;
}
```

In the `createCollabLib` return object, add:

```typescript
    docIdFromUrl(url: string): string {
      return docIdFromUrl(url);
    },
```

Add the import at the top of index.ts:

```typescript
import { truncateUrl, docIdFromUrl } from "./url-utils.js";
```

Update the re-export:

```typescript
export { truncateUrl, docIdFromUrl } from "./url-utils.js";
```

### Step 5: Run tests

Run: `npm test -w packages/core -- url-utils`
Expected: PASS

### Step 6: Commit

```bash
git add packages/core/src/url-utils.ts \
  packages/core/src/url-utils.test.ts \
  packages/core/src/index.ts
git commit -m "feat(core): add docIdFromUrl() to CollabLib

Extracts short display ID from capability URLs. Available
as both collab.docIdFromUrl(url) and a standalone export.
Long IPNS names truncated to first/last 6 chars."
```

### Step 7: Note example app simplification

After this commit, `recentDocs.ts` can:

- Remove the local `docIdFromUrl()` function
- Import `docIdFromUrl` from `@pokapali/core`

---

## Task 4: `doc.ready` — promise for first meaningful

state

The example app has a `useFragmentReady` hook that polls
`Y.Doc.getXmlFragment().length`. Core should expose
`doc.whenReady()` returning a promise that resolves when
the first snapshot is applied or when initial resolution
determines there's nothing to load.

**Files:**

- Modify: `packages/core/src/index.ts` (interface + impl)
- Test: `packages/core/src/index.test.ts`

### Step 1: Add `whenReady()` to the CollabDoc interface

In `packages/core/src/index.ts`, add to the `CollabDoc`
interface, after `hasAppliedSnapshot`:

```typescript
  /**
   * Resolves when the document has meaningful state:
   * either a remote snapshot was applied, initial IPNS
   * resolution found nothing to load, or the document
   * was locally created (resolves immediately).
   */
  whenReady(): Promise<void>;
```

### Step 2: Implement `whenReady()` in `createCollabDoc`

Add state variables near the top of `createCollabDoc`
(after `let destroyed = false;`):

```typescript
let readyResolved = false;
let resolveReady: (() => void) | null = null;
const readyPromise = new Promise<void>((resolve) => {
  resolveReady = resolve;
});

function markReady() {
  if (!readyResolved) {
    readyResolved = true;
    resolveReady?.();
  }
}
```

If `performInitialResolve` is falsy (i.e., this is a
`create()` call, not an `open()` call), resolve
immediately — newly created docs are ready from the
start:

```typescript
if (!params.performInitialResolve) {
  markReady();
}
```

In the `onSnapshot` callback inside the snapshot watcher
setup (after `emit("snapshot-applied")`), add:

```typescript
markReady();
```

We also need to resolve when initial IPNS resolution
finds nothing. The snapshot watcher already has
`hasAppliedSnapshot` and fetch state transitions. When
fetch state transitions to `"idle"` after having been
`"resolving"` and no snapshot was found, we should
resolve. Add after the `onFetchStateChange` callback:

```typescript
      onFetchStateChange: (state) => {
        emit("fetch-state", state);
        // If we transition back to idle after resolving
        // and never applied a snapshot, the document is
        // as ready as it's going to get.
        if (
          state.status === "idle" &&
          !readyResolved &&
          !snapshotWatcher?.hasAppliedSnapshot
        ) {
          markReady();
        }
      },
```

Add `whenReady()` to the returned object:

```typescript
    whenReady(): Promise<void> {
      return readyPromise;
    },
```

### Step 3: Write tests

These test the type contract and basic behavior. Full
integration requires Helia.

Add to `packages/core/src/index.test.ts`:

```typescript
describe("CollabDoc.whenReady", () => {
  it("is defined on the CollabDoc interface", () => {
    // Type-level test: whenReady returns a Promise
    type Check = ReturnType<CollabDoc["whenReady"]>;
    const _: Check = Promise.resolve();
    expect(_).toBeInstanceOf(Promise);
  });
});
```

### Step 4: Run tests

Run: `npm test -w packages/core`
Expected: PASS

### Step 5: Commit

```bash
git add packages/core/src/index.ts \
  packages/core/src/index.test.ts
git commit -m "feat(core): add whenReady() to CollabDoc

Returns a promise that resolves when the document has
meaningful state: first snapshot applied, IPNS resolution
found nothing, or doc was locally created. Replaces the
useFragmentReady polling hook in the example app."
```

### Step 6: Note example app simplification

After this commit, `Editor.tsx` can:

- Remove the `useFragmentReady` hook entirely
- Use `doc.whenReady()` in a `useEffect` or similar:
  ```typescript
  const [ready, setReady] = useState(false);
  useEffect(() => {
    doc.whenReady().then(() => setReady(true));
  }, [doc]);
  ```
- Remove the 3-second polling timeout fallback
- The `shouldMount` / `showEditor` logic simplifies to
  just checking `ready`

---

## Summary of example app cleanup (after all 4 tasks)

| File                   | What to remove                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ConnectionStatus.tsx` | `gatherInfo()`, `ConnectionInfo`/`RelayInfo`/`GossipSubInfo` types, `getHelia` import. Replace with `doc.diagnostics()` |
| `SharePanel.tsx`       | Local `truncateUrl()`. Import from core                                                                                 |
| `recentDocs.ts`        | Local `docIdFromUrl()`. Import from core                                                                                |
| `Editor.tsx`           | `useFragmentReady` hook. Use `doc.whenReady()`                                                                          |

The `getHelia` export from core can potentially be
removed from the public API once ConnectionStatus.tsx
no longer uses it, but that's a separate cleanup task.
