# Getting Started

Install `@pokapali/core` and its peer dependency:

```sh
npm install @pokapali/core yjs
```

> **TypeScript note:** if your `tsconfig.json` targets
> ES2022 or earlier, add `"skipLibCheck": true` to
> `compilerOptions`. A transitive dependency uses
> ES2024 types that would otherwise cause build errors.

## Create a document

```ts
import { pokapali } from "@pokapali/core";

const app = pokapali({
  appId: "my-app",
  channels: ["content"],
  origin: window.location.origin,
});

const doc = await app.create();
```

`appId` scopes relay discovery and key derivation —
use the same value across all clients of your app.
`channels` declares named Yjs subdocs for your data.
`origin` is the base URL for capability links.

## Read and write content

Each channel is a standard `Y.Doc`:

```ts
const ydoc = doc.channel("content");
const text = ydoc.getText("body");
text.insert(0, "Hello from pokapali!");
```

Use any Yjs shared type — `Y.Text`, `Y.Map`,
`Y.Array`, `Y.XmlFragment` (for rich-text editors).

## Share the document

Every document has capability URLs that encode
access level in the hash fragment:

```ts
doc.urls.admin; // full control
doc.urls.write; // edit + publish
doc.urls.read; // view only
```

Generate a scoped invite link:

```ts
const writeUrl = await doc.invite({
  channels: ["content"],
  canPushSnapshots: true,
});
```

## Open a shared document

```ts
const doc = await app.open(url);
await doc.ready(); // wait for content to arrive

const ydoc = doc.channel("content");
console.log(ydoc.getText("body").toString());
```

`ready()` resolves once content is available from
IndexedDB cache, connected peers, or pinner HTTP.

## Persist to the network

```ts
await doc.publish();
```

This creates an encrypted, content-addressed snapshot
that pinners replicate. Documents load even when the
original author is offline.

For automatic publishing, use `createAutoSaver`:

```ts
import { createAutoSaver } from "@pokapali/core";

const cleanup = createAutoSaver(doc);
// In React: useEffect(() => createAutoSaver(doc), [doc]);
```

## Observe status

Feeds are `{ getSnapshot(), subscribe() }` — they
work directly with React's `useSyncExternalStore`:

```ts
import { useSyncExternalStore } from "react";

function StatusBadge({ doc }) {
  const status = useSyncExternalStore(
    doc.status.subscribe,
    doc.status.getSnapshot,
  );
  return <span>{status}</span>;
}
```

Available feeds: `doc.status`, `doc.saveState`,
`doc.tip`, `doc.loading`, `doc.versions`,
`doc.clientIdMapping`.

## Clean up

```ts
doc.destroy();
```

## Next steps

- [Full API guide](guide.md) — comprehensive
  reference for all Doc methods, events, and patterns
- [examples/getting-started/](examples/getting-started/)
  — runnable Node.js scripts (create + open)
- Package READMEs for
  [@pokapali/comments](../packages/comments/),
  [@pokapali/node](../packages/node/),
  and other packages
