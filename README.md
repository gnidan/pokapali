# Pokapali

> **This project is not published to npm.** It is under
> active development and not yet ready for production use.

P2P collaborative document sync built on
[Yjs](https://yjs.dev), WebRTC, and IPFS. Handles
encryption, peer discovery, real-time sync, and persistent
snapshots so you can focus on your editor.

Documents are identified by an IPNS name in the URL path;
access level is encoded in the URL fragment as key material.
Sharing a URL shares a capability. No accounts, no servers,
no sign-up.

## Packages

| Package | Description |
|---|---|
| [`@pokapali/core`](packages/core) | Document lifecycle, snapshot push/pull, capability URLs |
| [`@pokapali/sync`](packages/sync) | WebRTC room setup via GossipSub signaling |
| [`@pokapali/crypto`](packages/crypto) | Key derivation (HKDF), Ed25519 signing, AES-GCM encryption |
| [`@pokapali/capability`](packages/capability) | Capability URL encoding/decoding and access level inference |
| [`@pokapali/subdocs`](packages/subdocs) | Yjs subdocument manager with namespace isolation |
| [`@pokapali/snapshot`](packages/snapshot) | Snapshot encoding, decoding, verification, and chain walking |
| [`@pokapali/node`](packages/node) | Relay server, pinner, and HTTP health endpoints (Node.js) |
| [`@pokapali/log`](packages/log) | Zero-dependency structured logging |

Most apps only import `@pokapali/core`. The other packages
are the building blocks it composes.

## Documentation

- **[Getting Started](docs/guide.md)** — build an app
  with Pokapali
- **[Architecture](docs/architecture.md)** — full design
  reference (URL structure, key derivation, threat model,
  namespace enforcement, snapshot chain, IPNS publishing)
- **[Dependencies](docs/deps.md)** — dependency versioning
  decisions

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
editor built with React and TipTap. It demonstrates
document creation, sharing via capability URLs, real-time
sync, read-only access, and connection diagnostics.

```sh
npm run dev
```

Opens at `http://localhost:3141`. Create a document, copy
the share URL, open it in another tab — edits sync in
real-time via WebRTC and persist via IPFS snapshots.

## How It Works

**Capability URLs** — the URL *is* the permission token.
The path contains the public IPNS name; the fragment
(never sent to servers) contains encrypted key material.
Which keys are present determines access level (admin,
writer, read-only).

**Namespace isolation** — each namespace (e.g. "content",
"comments") is a separate Yjs subdocument synced over its
own encrypted WebRTC room. Write enforcement is structural:
no key = no room = no connection.

**Snapshot persistence** — full document state is
periodically saved as a signed, encrypted IPFS block linked
into an append-only chain. Any single snapshot is sufficient
to recover the entire document.

**GossipSub signaling** — WebRTC connections are brokered
via GossipSub over the libp2p mesh. No external signaling
servers required.

**Zero-knowledge pinners** — relay/pinner nodes store and
serve encrypted blocks they cannot read. Anyone can run one.

See [docs/architecture.md](docs/architecture.md) for the
full design.

## License

[MIT](LICENSE)
