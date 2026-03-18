# Migration Guide

Breaking changes by version, with upgrade
instructions.

This project is pre-1.0 (`0.1.0-alpha.*`). Breaking
changes may occur between any alpha releases. This
guide covers every breaking change since the first
published version.

---

## 0.1.0-alpha.6

### Events replaced with Feeds (#189)

`doc.on()` / `doc.off()` are deprecated. Use Feed
subscriptions instead.

**Before:**

```ts
doc.on("snapshot", (event) => {
  /* ... */
});
doc.on("publish-needed", () => doc.publish());
doc.on("node-change", (nodes) => {
  /* ... */
});
```

**After:**

```ts
doc.snapshotEvents.subscribe((event) => {
  /* ... */
});

// For publish-needed, use auto-save or manual
// subscribe to doc.saveState:
doc.saveState.subscribe((state) => {
  if (state === "dirty") doc.publish();
});

doc.gossipActivity.subscribe((activity) => {
  /* ... */
});
```

The deprecated methods still work via an internal
Feed wrapper, but will be removed in a future release.

### Doc surface reduced (#187)

Several properties moved to `doc.diagnostics()` or
were removed entirely.

**Removed** (use `doc.diagnostics()` instead):

- `doc.relays`
- `doc.lastSaveError`
- `doc.clockSum`
- `doc.ipnsSeq`
- `doc.latestAnnouncedSeq`
- `doc.hasAppliedSnapshot`
- `doc.history()` — use `doc.versions` Feed
  (deprecated since pre-release, now removed)

**Deprecated** (will be removed in a future release):

- `doc.provider` — use `doc.channel()` for Yjs
  subdocs
- `doc.tipCid` — use `doc.tip` Feed
- `doc.ackedBy` — use `doc.tip` Feed
  (`tip.ackedBy`)
- `doc.guaranteeUntil` — use `doc.tip` Feed
  (`tip.guaranteeUntil`)
- `doc.retainUntil` — use `doc.tip` Feed
  (`tip.retainUntil`)
- `doc.loadingState` — use `doc.loading` Feed

### New Feeds

Alpha.6 adds several new Feeds. No migration needed
— these are additive:

- `doc.snapshotEvents` — snapshot event notifications
- `doc.gossipActivity` — GossipSub activity state
- `doc.backedUp` — pinner acknowledgment status

### `doc.ready()` accepts options (#227)

`doc.ready()` now accepts an optional `{ timeoutMs }`
parameter. The no-argument form still works (waits
indefinitely).

```ts
// New: reject after 30 seconds
await doc.ready({ timeoutMs: 30_000 });
```

---

## 0.1.0-alpha.2

### Yjs moved to peerDependency (#104)

`yjs` is now a `peerDependency` of `@pokapali/core`,
`@pokapali/sync`, and `@pokapali/subdocs`. This
prevents duplicate Yjs instances (which cause silent
CRDT corruption).

**Action:** Ensure your project has `yjs` as a direct
dependency:

```sh
npm install yjs
```

If you already depend on `yjs` directly, no change
is needed.

---

## Pre-release changes

These changes happened before the first npm publish
(0.1.0-alpha.2). They only affect consumers who were
using the library from source.

### `namespace` renamed to `channel`

All public APIs use `channel` instead of `namespace`.

**Before:**

```ts
const app = pokapali({
  appId: "my-app",
  namespaces: ["content", "comments"],
});

doc.namespace("content");
doc.capability.namespaces.has("content");
doc.invite({ namespaces: ["comments"] });
```

**After:**

```ts
const app = pokapali({
  appId: "my-app",
  channels: ["content", "comments"],
});

doc.channel("content");
doc.capability.channels.has("content");
doc.invite({ channels: ["comments"] });
```

### `doc.history()` deprecated

Replaced by the `doc.versions` Feed. Fully removed
in alpha.6 (see [Doc surface reduced](#doc-surface-reduced-187)
above).

```ts
// Before
const versions = await doc.history();

// After
doc.versions.subscribe((versions) => {
  // reactive updates as chain is walked
});

// Or read once:
const versions = doc.versions.getSnapshot();
```

### `snapshot-lifecycle.ts` renamed

The internal module `snapshot-lifecycle.ts` was
renamed to `snapshot-codec.ts`. This only affects
consumers using deep imports (which are classified
as internal — see [api-stability.md](api-stability.md)).

---

## Reference

- **[CHANGELOG](../CHANGELOG.md)** — version-specific
  release notes and breaking changes
