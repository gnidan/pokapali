# Pokapali

[![relays](https://img.shields.io/endpoint?url=https://gnidan.github.io/pokapali/badges/relays.json)](https://github.com/gnidan/pokapali/actions/workflows/health-check.yml)
[![mesh](https://img.shields.io/endpoint?url=https://gnidan.github.io/pokapali/badges/mesh.json)](https://github.com/gnidan/pokapali/actions/workflows/health-check.yml)
[![pinned docs](https://img.shields.io/endpoint?url=https://gnidan.github.io/pokapali/badges/pinned.json)](https://github.com/gnidan/pokapali/actions/workflows/health-check.yml)
[![example app](https://img.shields.io/badge/example-app-purple)](https://gnidan.github.io/pokapali/)

P2P collaborative document sync built on
[Yjs](https://yjs.dev), WebRTC, and IPFS. Handles
encryption, peer discovery, real-time sync, and persistent
snapshots so you can focus on your editor.

Documents are identified by an
[IPNS](https://docs.ipfs.tech/concepts/ipns/) name
(a self-certifying identifier) in the URL path;
access level is encoded in the URL fragment as key material.
Sharing a URL shares a capability. No accounts, no servers,
no sign-up.

```ts
import { pokapali } from "@pokapali/core";

const app = pokapali({
  appId: "my-app",
  channels: ["content"],
  origin: window.location.origin,
});

// Create a document (you become admin)
const doc = await app.create();

// Edit via Yjs
const ytext = doc.channel("content").getText("body");
ytext.insert(0, "Hello, world!");

// Share — the URL encodes the access level
console.log(doc.urls.write); // writer invite
console.log(doc.urls.read); // read-only link

// Open from a capability URL
const doc2 = await app.open(someUrl);
```

## Packages

| Package                                                 | Description                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| [`@pokapali/core`](packages/core)                       | Document lifecycle, snapshot push/pull, capability URLs         |
| [`@pokapali/sync`](packages/sync)                       | WebRTC room setup via GossipSub signaling                       |
| [`@pokapali/crypto`](packages/crypto)                   | Key derivation (HKDF), Ed25519 signing, AES-GCM encryption      |
| [`@pokapali/capability`](packages/capability)           | Capability URL encoding/decoding and access level inference     |
| [`@pokapali/subdocs`](packages/subdocs)                 | Yjs subdocument manager with channel isolation                  |
| [`@pokapali/snapshot`](packages/snapshot)               | Snapshot encoding, decoding, verification, and chain walking    |
| [`@pokapali/node`](packages/node)                       | Relay server, pinner, and HTTP block/health endpoints (Node.js) |
| [`@pokapali/log`](packages/log)                         | Zero-dependency structured logging                              |
| [`@pokapali/comments`](packages/comments)               | Comment threads with anchored text ranges                       |
| [`@pokapali/comments-tiptap`](packages/comments-tiptap) | Tiptap extension for comment highlighting and pending anchors   |
| [`@pokapali/react`](packages/react)                     | React hooks for Doc state, participants, and comments           |
| [`@pokapali/test-utils`](packages/test-utils)           | Test helpers and simulated network                              |

Most apps only import `@pokapali/core`. The other
packages are the building blocks it composes.

## Documentation

- **[Getting Started](docs/getting-started.md)** —
  quick start with runnable examples
- **[Guide](docs/guide.md)** — build an app with
  Pokapali
- **[Integration Guide](docs/integration-guide.md)**
  — add pokapali to an existing editor
- **[API Stability](docs/api-stability.md)** — which
  APIs are safe to depend on (Stable / Experimental
  / Internal tiers)
- **[Security Model](docs/security-model.md)** —
  capability URLs, encryption, trust model, identity,
  and document recovery
- **[Troubleshooting](docs/troubleshooting.md)** —
  common errors and how to fix them
- **[Internals](docs/internals/)** — architecture,
  design principles, security design, and dependency
  decisions (for contributors)

## Development

```sh
# Install dependencies
npm install

# Build all packages
npx tsc --build

# Run tests
npm test

# Run the example app (Vite dev server)
npm run dev

# Run a local relay + pinner node
npm run dev:node
```

Monorepo managed with npm workspaces. TypeScript
throughout, targeting ES2022/ESNext.

## Example App

The [example app](apps/example) is a collaborative text
editor built with React and Tiptap. It demonstrates
document creation, sharing via capability URLs, real-time
sync, read-only access, threaded comments, version
history, and connection diagnostics.

```sh
npm run dev
```

Opens at `http://localhost:3141`. Create a document, copy
the share URL, open it in another tab — edits sync in
real-time via WebRTC and persist via IPFS snapshots.

## How It Works

**Capability URLs** — the URL _is_ the permission token.
The path contains the public IPNS name; the fragment
(never sent to servers) contains encrypted key material.
Which keys are present determines access level (admin,
writer, read-only).

**Channel isolation** — each channel (e.g. "content",
"comments") is a separate Yjs subdocument synced over its
own encrypted WebRTC room. Write enforcement is structural:
no key = no room = no connection.

**Snapshot persistence** — full document state is
periodically saved as a signed, encrypted IPFS block linked
into an append-only chain. Any single snapshot is sufficient
to recover the entire document.

**GossipSub signaling** — WebRTC connections are brokered
via [GossipSub](https://docs.libp2p.io/concepts/pubsub/overview/)
(a peer-to-peer pub/sub protocol) over the libp2p mesh.
No external signaling servers required.

**Zero-knowledge pinners** — relay/pinner nodes store and
serve encrypted blocks they cannot read (they persist data
without knowing its content). Anyone can run one.

See [Internals](docs/internals/) for the full design.

## License

[MIT](LICENSE)
