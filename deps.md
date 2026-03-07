# Dependency Versioning Decisions

## @noble/ed25519 ^2.2.0

Using `@noble/ed25519` (not `@noble/curves`) for a smaller, focused
Ed25519-only package. v2.x is pure JS with no dependencies, audited,
and supports both browser and Node. The broader `@noble/curves`
package would also work but pulls in more code than needed.

## yjs ^13.6.0

The CRDT engine. v13 is the current stable line with subdocument
support required for namespace isolation. Well-maintained and widely
deployed.

## y-webrtc ^10.3.0

P2P real-time sync provider. v10.x includes the `password` option for
room encryption (used for namespace access key enforcement). Note:
requires a signaling server; public `wss://signaling.yjs.dev` is
available, or self-host the ~30-line server from the y-webrtc repo.

## y-indexeddb ^9.0.12

Local persistence in the browser via IndexedDB. v9.x is the current
stable release compatible with yjs 13.x. Stores raw (unencrypted) Yjs
updates; see architecture.md for encryption-at-rest considerations.

## @ipld/dag-cbor ^9.2.0

CBOR encoding for IPFS snapshot blocks. Chosen over `cbor-x` because
`@ipld/dag-cbor` integrates directly with the IPLD/multiformats
ecosystem (CID links, block codecs) — no manual CID
serialization/deserialization needed. `cbor-x` is faster for raw CBOR
but lacks IPLD-native CID handling.

## multiformats ^13.3.0

CID creation, hashing, and codec infrastructure. v13.x is the current
stable line used across the Helia/IPFS ecosystem.

## helia ^5.1.0

IPFS implementation for browser and Node. v5.x is the current stable
release. Note: browser bundle is large (~500KB+ min+gzip for the full
stack). See architecture.md for lazy-loading and tree-shaking
strategies.

## @helia/ipns ^8.0.0

IPNS publish/resolve for Helia. v8.x supports both pubsub and DHT
routing (both needed — pubsub for immediacy, DHT for persistence).

## y-protocols ^1.0.6

Provides the `Awareness` type used for cursor presence. v1.x is the
stable release compatible with yjs 13.x.

## @tiptap/* ^2.11.0

TipTap editor framework for the example app. v2.11.x is the current
stable line. Packages used: `@tiptap/core`, `@tiptap/pm`,
`@tiptap/starter-kit`, `@tiptap/extension-collaboration`,
`@tiptap/extension-collaboration-cursor`. These are app-side
dependencies only, not part of the library.

## react / react-dom ^19.0.0

React 19 for the example app. v19.x is the current stable release.
App-side dependency only.
