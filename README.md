# pokapali

Serverless, encrypted, peer-to-peer collaborative document sync.
Built on [Yjs](https://yjs.dev), WebRTC, IndexedDB, and IPFS.

pokapali lets multiple users collaborate on structured documents
in real time without any central server. Documents are encrypted
end-to-end, synced over WebRTC, and persisted as IPFS snapshots.
Access control is capability-based: the URL _is_ the permission
token.

## Status

**Alpha.** The core library, crypto, capability encoding, subdoc
management, sync, snapshot chain, version history, and pinner are
implemented and tested. Helia/IPNS integration for IPFS-based
snapshot publishing and read-only peer delivery is deferred. Key
revocation is in progress.

## Key Features

- **No server required** -- peers sync directly via WebRTC;
  pinning servers are permission-less and fungible
- **End-to-end encrypted** -- document content is encrypted with
  a symmetric key derived from a shared secret in the URL
  fragment; relays and pinners never see plaintext
- **Capability-based access control** -- admin, write, and
  read-only permission levels encoded directly in the URL
- **Namespace isolation** -- each namespace (e.g., "content",
  "comments") is a separate Yjs subdocument synced over its own
  encrypted WebRTC room; write enforcement is structural, not
  cooperative
- **Snapshot persistence** -- full document state is periodically
  saved as a signed, encrypted, content-addressed IPFS block
  linked into an append-only chain
- **Works with any Yjs editor** -- TipTap, ProseMirror,
  CodeMirror, Monaco, or any binding that accepts a `Y.Doc`

## Quick Start

```
npm install @pokapali/core
```

### Create a document

```ts
import { createCollabLib } from "@pokapali/core";

const collab = createCollabLib({
  appId: "com.example.my-editor",
  namespaces: ["content", "comments"],
  base: "https://my-app.example.com",
});

const doc = await collab.create();

// Bind to your editor
const yDoc = doc.subdoc("content");
// e.g. Collaboration.configure({ document: yDoc })

// Share with collaborators
console.log(doc.adminUrl); // full access
console.log(doc.writeUrl); // read + write + snapshot push
console.log(doc.readUrl); // read-only
```

### Open an existing document

```ts
const doc = await collab.open(url);

const isReadOnly = !doc.capability.namespaces.has("content");

// Bind to editor with appropriate permissions
const yDoc = doc.subdoc("content");
```

### Generate invite URLs

```ts
// Comments-only collaborator
const commentUrl = await doc.inviteUrl({
  namespaces: ["comments"],
  canPushSnapshots: false,
});

// Full writer who can also push snapshots
const writerUrl = await doc.inviteUrl({
  namespaces: ["content", "comments"],
  canPushSnapshots: true,
});
```

### Snapshot management

The library does not auto-save. Your app controls when snapshots
are pushed:

```ts
// Push on a timer or user action
await doc.pushSnapshot();

// React to the library's hint that a push is timely
doc.on("snapshot-recommended", () => {
  doc.pushSnapshot();
});

// Show save state in UI
doc.on("status", (status) => {
  // "connecting" | "syncing" | "synced"
  // | "offline" | "unpushed-changes"
});
```

## Architecture Overview

### Key Derivation

All cryptographic keys are derived from a single admin secret
via HKDF (RFC 5869). The `appId` string is baked into key
derivation to prevent cross-app collisions.

```
adminSecret
  |-- HKDF("read")       -> readKey (AES-GCM-256)
  |-- HKDF("ipns")       -> ipnsKeyBytes (Ed25519 seed)
  |-- HKDF("rotation")   -> rotationKey
  |-- HKDF("awareness-room") -> awarenessRoomPassword
  |-- HKDF("ns:content") -> namespace key for "content"
  |-- HKDF("ns:comments") -> namespace key for "comments"
  ...
```

### Namespace Enforcement

Each namespace is a separate Yjs subdocument with its own
WebRTC room. The room password is derived from the namespace
access key. A peer without the key cannot complete the WebRTC
signaling handshake -- enforcement is at connection
establishment, not message filtering.

Read-only peers join no content rooms. They receive updates
via IPFS snapshot fetches (once Helia integration lands).

### Snapshot Chain

Snapshots are full-state captures of all subdocuments, encrypted
with `readKey`, signed with the IPNS key, and linked into an
append-only DAG:

```
IPNS name -> CID_n (latest) --prev--> CID_n-1 --prev--> ... --prev--> CID_1
```

Each snapshot is independently sufficient to recover the full
document. The `prev` chain exists for version history only.

### Capability URLs

```
https://my-app.example.com/doc/<ipns-name>#<key-material>
```

The path contains the public document identity (IPNS name).
The fragment (never sent to servers) contains the encrypted key
material. Which keys are present determines the capability:

| Level     | Keys in fragment                                                         |
| --------- | ------------------------------------------------------------------------ |
| Admin     | readKey, ipnsKey, rotationKey, awarenessRoomPassword, all namespace keys |
| Writer    | readKey, ipnsKey, awarenessRoomPassword, granted namespace keys          |
| Read-only | readKey, awarenessRoomPassword                                           |

Capabilities can only be narrowed, never escalated. A writer
can generate read-only URLs but not admin URLs.

## Packages

| Package                | Description                                                    |
| ---------------------- | -------------------------------------------------------------- |
| `@pokapali/core`       | Integration layer: create/open docs, manage sync and snapshots |
| `@pokapali/crypto`     | Key derivation (HKDF), AES-GCM encryption, Ed25519 signing     |
| `@pokapali/capability` | Encode/decode capability URLs, narrow permissions              |
| `@pokapali/subdocs`    | Yjs subdocument lifecycle and dirty tracking                   |
| `@pokapali/snapshot`   | Snapshot encoding/decoding, chain validation, fetch coalescing |
| `@pokapali/sync`       | WebRTC room setup for namespace sync and awareness             |
| `@pokapali/pinner`     | Node.js pinning server: ingest, validate, rate-limit, persist  |

Most consumers only need `@pokapali/core`. The other packages
are the building blocks it composes.

## Capability Model

pokapali uses a capability-based security model where the URL
itself is the access token. There are three levels:

**Admin** -- holds all keys including `rotationKey`. Can generate
URLs at any permission level. Can initiate key rotation for
revocation.

**Writer** -- holds `readKey`, `awarenessRoomPassword`,
`ipnsKey` (if granted `canPushSnapshots`), and one or more
namespace access keys. Can read all content, write to granted
namespaces, and optionally push snapshots.

**Read-only** -- holds only `readKey` and
`awarenessRoomPassword`. Can decrypt and view all content. Can
see cursor presence via the awareness room. Cannot write to any
namespace.

`canPushSnapshots` is an independent trust flag, not implied by
write access. It controls whether a peer can publish new IPFS
snapshots, which affects what read-only peers and cold-booting
peers see. Grant it deliberately.

## What's Deferred

- **Helia/IPNS integration** -- IPFS-based snapshot publishing,
  read-only peer delivery via IPNS pubsub, and DHT routing are
  not yet wired up. Snapshots are currently stored in-memory.
- **Key revocation** -- the `rotationKey`-based document
  migration flow is specified but not implemented.
- **Encrypted local persistence** -- IndexedDB stores
  unencrypted Yjs state by default. An encrypted adapter is
  planned but not built.

## Development

```
git clone https://github.com/gnidan/pokipali.git
cd pokapali
npm install
npm run build
npm test
```

Monorepo managed with npm workspaces. TypeScript throughout,
targeting ES2022/ESNext.

## License

MIT
