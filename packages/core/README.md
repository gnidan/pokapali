# @pokapali/core

The main integration package for pokapali — a
serverless, encrypted, peer-to-peer collaborative
document sync library. This is the only package most
apps need to import.

## Install

```sh
npm install @pokapali/core
```

**TypeScript note:** If your project targets ES2022,
add `"skipLibCheck": true` to your `tsconfig.json`.
A transitive dependency (`it-queue` via libp2p) uses
`PromiseWithResolvers` which requires ES2024+ lib
typings. This does not affect runtime behavior.

## Quick Start

```typescript
import { pokapali } from "@pokapali/core";

// 1. Initialize once per app
const app = pokapali({
  appId: "my-app",
  channels: ["content"],
  origin: "https://my-app.com",
});

// 2. Create a new document
const doc = await app.create();
console.log("Admin URL:", doc.urls.admin);
console.log("Write URL:", doc.urls.write);
console.log("Read URL:", doc.urls.read);

// 3. Access a channel as a Y.Doc
const ydoc = doc.channel("content");
const text = ydoc.getText("body");
text.insert(0, "Hello from pokapali!");

// 4. Subscribe to reactive state
doc.status.subscribe(() => {
  console.log("Status:", doc.status.getSnapshot());
});
doc.saveState.subscribe(() => {
  console.log("Save:", doc.saveState.getSnapshot());
});

// 5. Publish a snapshot
await doc.publish();

// 6. Generate a write invite URL
const writeUrl = await doc.invite({
  channels: ["content"],
  canPushSnapshots: true,
});

// 7. Open an existing document
const doc2 = await app.open(writeUrl);
await doc2.ready();
console.log(doc2.channel("content").getText("body").toString());

// 8. Clean up
doc.destroy();
doc2.destroy();
```

See
[examples/getting-started/](../../docs/examples/getting-started/)
for runnable create and open scripts.

## API

### Factory

- **`pokapali(config)`** — returns a `PokapaliApp`
  with `create()` and `open(url)` methods

### PokapaliConfig

```typescript
{
  appId: string;       // scopes key derivation +
                       // relay discovery
  channels: string[];  // named Yjs subdocuments
  origin: string;      // base URL for capability links
  primaryChannel?: string;  // defaults to channels[0]
  rtc?: object;        // WebRTC peer options
}
```

### Doc

| Property / Method | Description                               |
| ----------------- | ----------------------------------------- |
| `channel(name)`   | Y.Doc for the named channel               |
| `publish()`       | Push snapshot to IPFS                     |
| `ready()`         | Resolves when content is available        |
| `invite(grant)`   | Generate a narrowed capability URL        |
| `destroy()`       | Clean up all connections                  |
| `urls`            | `{ admin, write, read, best }`            |
| `capability`      | `{ channels, canPushSnapshots, isAdmin }` |
| `awareness`       | Yjs Awareness instance (cursor state)     |

### Reactive Feeds

Feeds are `{ getSnapshot(), subscribe() }` —
compatible with React's `useSyncExternalStore`.

| Feed            | Type                  | Description          |
| --------------- | --------------------- | -------------------- |
| `doc.status`    | `DocStatus`           | Connectivity state   |
| `doc.saveState` | `SaveState`           | Persistence state    |
| `doc.tip`       | `VersionInfo \| null` | Latest snapshot info |
| `doc.loading`   | `LoadingState`        | Fetch progress       |
| `doc.versions`  | `VersionHistory`      | Version list         |

### Snapshot Events

```typescript
doc.snapshotEvents.subscribe(() => {
  const event = doc.snapshotEvents.getSnapshot();
  if (event) console.log("snapshot:", event.cid);
});
```

## Editor Integration

Works with any Yjs-aware editor:

```typescript
import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";

const editor = new Editor({
  extensions: [
    Collaboration.configure({
      document: doc.channel("content"),
    }),
    CollaborationCursor.configure({
      provider: { awareness: doc.awareness },
    }),
  ],
});
```

## Related Packages

| Package                                | Purpose                    |
| -------------------------------------- | -------------------------- |
| [@pokapali/comments](../comments/)     | Anchored threaded comments |
| [@pokapali/test-utils](../test-utils/) | In-memory test transport   |
| [@pokapali/node](../node/)             | Relay + pinner server      |
| [@pokapali/log](../log/)               | Structured logging         |

## Internals

<details>
<summary>Internal modules (for contributors)</summary>

These are implementation details, not public API.
Do not import from sub-entry points (`/announce`,
`/block-upload`, `/snapshot-codec`, `/ipns-helpers`)
unless you are building server infrastructure.

| Module                | Purpose                 |
| --------------------- | ----------------------- |
| `facts.ts`            | Fact union, state types |
| `reducers.ts`         | Pure state reducers     |
| `sources.ts`          | Async streams, Feed     |
| `interpreter.ts`      | Effect dispatcher       |
| `create-doc.ts`       | Doc wiring              |
| `snapshot-codec.ts`   | Snapshot encode/decode  |
| `block-resolver.ts`   | Block resolution        |
| `fetch-block.ts`      | Block fetch + retry     |
| `fetch-tip.ts`        | HTTP tip fetch          |
| `announce.ts`         | GossipSub protocol      |
| `node-registry.ts`    | Peer tracking           |
| `peer-discovery.ts`   | Relay DHT discovery     |
| `helia.ts`            | Shared IPFS node        |
| `auto-save.ts`        | Debounced auto-publish  |
| `topology-sharing.ts` | Network topology        |

</details>

## Links

- [Getting Started](../../docs/getting-started.md)
- [Full API Guide](../../docs/guide.md)
- [Architecture](../../docs/internals/)
- [Examples](../../docs/examples/getting-started/)
