# Dependency Versioning Decisions

## @noble/ed25519 ^2.2.0

Using `@noble/ed25519` (not `@noble/curves`) for a smaller, focused
Ed25519-only package. v2.x is pure JS with no dependencies, audited,
and supports both browser and Node. The broader `@noble/curves`
package would also work but pulls in more code than needed.

## yjs ^13.6.0

The CRDT engine. v13 is the current stable line with subdocument
support required for channel isolation. Well-maintained and widely
deployed.

## y-webrtc ^10.3.0

P2P real-time sync provider. v10.x includes the `password` option for
room encryption (used for channel access key enforcement). Signaling
is handled exclusively via GossipSub through the libp2p mesh — no
WebSocket signaling servers are used.

Patched via `patch-package` (two patches): (1) fixes a
`glareToken` crash in the original code; (2) exports
`signalingConns` from the module and extracts
`setupSignalingHandlers` so that the GossipSub signaling
adapter can duck-type as a `SignalingConn` without
subclassing.

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

IPNS publish/resolve for Helia. Browser clients publish via
delegated HTTP routing (`delegatedRouting.putIPNS`) and resolve
via delegated HTTP first with DHT fallback. The pinner uses
`republishRecord` to re-put existing signed IPNS records on
the DHT without needing the writer's private key — this keeps
records alive when writers are offline.

## ipns

IPNS record creation (`createIPNSRecord`) and validation
(`ipnsValidator`, `ipnsSelector`). Used by `@pokapali/core`
to create signed IPNS records with the Y.Doc clockSum as
sequence number, and by `@pokapali/node` relay for DHT
validation.

## y-protocols ^1.0.6

Provides the `Awareness` type used for cursor presence. v1.x is the
stable release compatible with yjs 13.x.

## @tiptap/\* ^2.11.0

TipTap editor framework for the example app. v2.11.x is the current
stable line. Packages used: `@tiptap/core`, `@tiptap/pm`,
`@tiptap/starter-kit`, `@tiptap/extension-collaboration`,
`@tiptap/extension-collaboration-cursor`. These are app-side
dependencies only, not part of the library.

## @chainsafe/libp2p-gossipsub ^14.1.2

GossipSub pubsub for WebRTC signaling, peer discovery,
snapshot announcements, pinner acks, and node capability
broadcasting. Used in @pokapali/core (browser) and
@pokapali/node (relay). Relays use `floodPublish: false`
with mesh routing (D=3, Dlo=2, Dhi=8) and peer tagging
(tag value 200) for relay-to-relay delivery. Browsers
use `floodPublish: false` with mesh routing
(D=3, Dlo=2, Dhi=6, Dout=1, Dscore=1). `maxOutboundBufferSize`
set to 10MB (default Infinity caused OOM). IP colocation
scoring disabled (`IPColocationFactorWeight: 0`) because
browser peers connect via p2p-circuit through relay IPs,
triggering false positives. Pinned to versions compatible
with helia ^5.5.1 / libp2p 2.

## @libp2p/crypto/keys

Keypair generation from seed (`generateKeyPairFromSeed`)
and public key reconstruction (`publicKeyFromRaw`). Used
by `@pokapali/core` for IPNS publishing and by
`@pokapali/node` for relay identity persistence.

## @libp2p/pubsub-peer-discovery

Browser peer discovery via GossipSub. Peers announce
themselves on a shared topic
(`pokapali._peer-discovery._p2p._pubsub`) and discover
each other without needing a centralized registry.

## @libp2p/kad-dht

Kademlia DHT for `@pokapali/node` relay. Runs in
client-mode: provides records (network-wide CID for
relay discovery, IPNS records for persistence) but does
not serve DHT queries, avoiding inbound connections from
DHT walkers. Configured with IPNS validator/selector.

## @ipshipyard/libp2p-auto-tls

Automatic TLS certificate provisioning for relay WSS
endpoints and the HTTPS block endpoint. On startup, the
relay obtains a wildcard certificate for
`*.<base36-peerid>.libp2p.direct` from the libp2p
certificate authority, enabling browsers on HTTPS pages
to connect directly via secure WebSocket. The same
certificate is reused by the HTTPS block endpoint server
(port 4443) — accessed via the `certificate:provision`
event or `autoTLS.certificate` property, providing
zero-config TLS for block uploads and downloads.

## blockstore-fs

Persistent file-based blockstore for relay/pinner. Stores
snapshot blocks at `storagePath/blockstore/` so they
survive restarts. Shared between the pinner (read/write)
and the HTTP block endpoint (read for GET, write for
POST) — blocks uploaded via HTTP POST are immediately
available to the co-located pinner without any protocol
changes. Note: v3 `get()` returns an `AsyncGenerator`,
not a `Uint8Array` — wrapped with a safe type-check
adapter in relay code.

## datastore-level

Persistent LevelDB-backed datastore for relay. Stores
the libp2p peer store and DHT records across restarts.

## @pokapali/log (internal)

Zero-dependency structured logging package. Provides
`createLogger(module)` factory with level filtering
(`POKAPALI_LOG_LEVEL` env var or `localStorage` key).
Levels: `debug`, `info`, `warn`, `error`, `silent`.
The `silent` level suppresses all output — used in the
test runner (`POKAPALI_LOG_LEVEL=silent vitest run`)
to eliminate log noise. Used by all other `@pokapali/*`
packages. Placed as a separate leaf package (not in
`@pokapali/core`) to avoid a dependency cycle —
`@pokapali/sync` does not depend on core, but both
need logging.

## husky ^9.1.7

Git hooks manager. Runs `lint-staged` as a pre-commit
hook to enforce formatting and lint rules on staged
files before they enter the repository. v9.x uses a
simple `.husky/pre-commit` shell script (no JSON
config). The `prepare` script in root `package.json`
installs hooks on `npm install`.

## lint-staged ^16.3.3

Runs linters on git-staged files only. Configured in
root `package.json`: prettier + eslint --fix on
`*.{ts,tsx,js,jsx}`, prettier-only on
`*.{json,md,yml,yaml,css}`. Keeps commits clean
without requiring a full-repo lint pass.

## react / react-dom ^19.0.0

React 19 for the example app. v19.x is the current stable release.
App-side dependency only.
