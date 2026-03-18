# @pokapali/subdocs

```sh
npm install @pokapali/subdocs
```

Yjs subdocument manager with channel isolation. Creates
and manages one `Y.Doc` per channel, tracks dirty state
(whether local changes exist since the last snapshot), and
handles snapshot application with origin markers so
snapshot-sourced updates can be distinguished from local
edits.

## Quick Example

```ts
import { createSubdocManager, SNAPSHOT_ORIGIN } from "@pokapali/subdocs";

// Create a manager with two channels
const mgr = createSubdocManager("doc-ipns-name", ["content", "comments"]);

// Access a channel's Y.Doc
const contentDoc = mgr.subdoc("content");
const ytext = contentDoc.getText("body");
ytext.insert(0, "Hello!");

// Check dirty state (local edits since last snapshot)
console.log(mgr.isDirty); // true

// Encode all subdocs for snapshotting
const encoded = mgr.encodeAll();
// { content: Uint8Array, comments: Uint8Array,
//   _meta: Uint8Array }

// Apply a remote snapshot
mgr.applySnapshot(remoteData);
// Updates are applied with SNAPSHOT_ORIGIN so
// dirty tracking ignores them

mgr.destroy();
```

## Key Exports

- **`createSubdocManager(channels)`** — factory that
  initializes a `Y.Doc` per channel with IndexedDB
  persistence and dirty tracking
- **`SubdocManager`** — interface with `subdoc(name)`,
  `encodeAll()`, `applySnapshot()`, `dirty`, `destroy()`
- **`SNAPSHOT_ORIGIN`** — transaction origin marker for
  snapshot-applied updates

## Links

- [Root README](../../README.md)
- [Architecture — Channel Isolation](../../docs/internals/)
