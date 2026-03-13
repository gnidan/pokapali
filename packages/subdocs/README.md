# @pokapali/subdocs

```sh
npm install @pokapali/subdocs
```

Yjs subdocument manager with namespace isolation. Creates
and manages one `Y.Doc` per namespace, tracks dirty state
(whether local changes exist since the last snapshot), and
handles snapshot application with origin markers so
snapshot-sourced updates can be distinguished from local
edits.

## Key Exports

- **`createSubdocManager(namespaces)`** — factory that
  initializes a `Y.Doc` per namespace with IndexedDB
  persistence and dirty tracking
- **`SubdocManager`** — interface with `subdoc(ns)`,
  `encodeAll()`, `applySnapshot()`, `dirty`, `destroy()`
- **`SNAPSHOT_ORIGIN`** — transaction origin marker for
  snapshot-applied updates

## Links

- [Root README](../../README.md)
- [Architecture — Namespace Enforcement](../../docs/architecture.md)
