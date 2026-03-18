# API Stability

Every public export is classified into one of three
tiers. This document helps you decide which APIs are
safe to depend on and which may change.

## Tiers

| Tier             | Meaning                                                             |
| ---------------- | ------------------------------------------------------------------- |
| **Stable**       | Will not break within the 0.x series. Safe to depend on.            |
| **Experimental** | May change based on consumer feedback. Use at your own risk.        |
| **Internal**     | Exposed for inter-package use. Not intended for external consumers. |

## @pokapali/core

### Stable

| Export              | Description                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pokapali(options)` | Factory — returns `PokapaliApp`                                                                               |
| `PokapaliConfig`    | Configuration type                                                                                            |
| `PokapaliApp`       | App instance (`.create()`, `.open()`)                                                                         |
| `Doc`               | Document handle — `.channel()`, `.publish()`, `.invite()`, `.urls`, `.destroy()`, `.capability`, `.awareness` |
| `DocUrls`           | `{ admin, write, read, best }`                                                                                |
| `Feed<T>`           | Reactive container (`getSnapshot`, `subscribe`)                                                               |
| `DocStatus`         | `"connecting" \| "synced" \| "receiving" \| "offline"`                                                        |
| `SaveState`         | `"saved" \| "dirty" \| "saving" \| "unpublished"`                                                             |
| `VersionInfo`       | Snapshot metadata (cid, seq, ts)                                                                              |
| `DocRole`           | Role discriminator                                                                                            |
| `SnapshotEvent`     | Snapshot event payload                                                                                        |
| `truncateUrl()`     | Shorten a capability URL for display                                                                          |
| `docIdFromUrl()`    | Extract IPNS name from a capability URL                                                                       |
| `Capability`        | Re-exported from `@pokapali/capability` — access level info                                                   |
| `CapabilityGrant`   | Re-exported from `@pokapali/capability` — scoped invite grant                                                 |

#### Feeds on Doc

All Feeds are stable as types (`Feed<T>` interface).
The specific Feeds on Doc vary by stability tier:

| Feed                   | Type                   | Tier         |
| ---------------------- | ---------------------- | ------------ |
| `status`               | `Feed<DocStatus>`      | Stable       |
| `saveState`            | `Feed<SaveState>`      | Stable       |
| `tip`                  | `Feed<VersionInfo>`    | Stable       |
| `loading`              | `Feed<LoadingState>`   | Experimental |
| `backedUp`             | `Feed<boolean>`        | Experimental |
| `versions`             | `Feed<VersionHistory>` | Experimental |
| `snapshotEvents`       | `Feed<SnapshotEvent>`  | Stable       |
| `gossipActivity`       | `Feed<GossipActivity>` | Experimental |
| `clientIdMapping`      | `Feed<IdentityMap>`    | Experimental |
| `lastPersistenceError` | `Feed<string\|null>`   | Experimental |

#### Deprecated (will be removed in 0.2.0)

These APIs still work but have Feed-based
replacements. Migrate before the next major:

| Deprecated           | Replacement                             |
| -------------------- | --------------------------------------- |
| `doc.on(event, cb)`  | `doc.<feed>.subscribe(cb)`              |
| `doc.off(event, cb)` | Return value of `.subscribe()`          |
| `doc.provider`       | `doc.awareness` (direct access)         |
| `doc.tipCid`         | `doc.tip.getSnapshot()?.cid`            |
| `doc.ackedBy`        | `doc.tip.getSnapshot()?.ackedBy`        |
| `doc.guaranteeUntil` | `doc.tip.getSnapshot()?.guaranteeUntil` |
| `doc.retainUntil`    | `doc.tip.getSnapshot()?.retainUntil`    |
| `doc.loadingState`   | `doc.loading.getSnapshot()`             |

### Experimental

These APIs work but may change shape:

- `LoadingState`, `VersionHistory`,
  `VersionHistoryEntry`, `VersionEntryStatus`
- `GossipActivity`, `ParticipantInfo`,
  `ClientIdentityInfo`, `doc.clientIdMapping`
- `fetchVersionHistory()`, `VersionEntry`,
  `VersionTier`
- `createAutoSaver()`, `AutoSaveOptions`
- `Diagnostics`, `NodeInfo`, `GossipSubDiagnostic`
- `TopologyGraph`, `TopologyNode`, `TopologyEdge`,
  `TopologyGraphEdge`
- `AwarenessTopology`, `AwarenessKnownNode`
- `doc.configuredChannels` — channels configured for
  the app (compare with `capability.channels` to
  detect missing keys for re-invite flows)
- `doc.lastPersistenceError` — IDB write failure
  notifications (added in alpha.7)

### Internal

Do not depend on these — they exist for
`@pokapali/node` and other internal packages:

- `encodeForwardingRecord()`,
  `decodeForwardingRecord()`,
  `verifyForwardingRecord()`, `ForwardingRecord`
- `NODE_CAPS_TOPIC`, `_resetNodeRegistry()`
- `KnownNode`, `Neighbor`, `NodeRegistry`,
  `NodeRegistryEvents`
- `RotateResult`

Core sub-entry points (`@pokapali/core/announce`,
`@pokapali/core/block-upload`,
`@pokapali/core/snapshot-codec`,
`@pokapali/core/ipns-helpers`) are all internal.

## @pokapali/crypto — All Stable

`generateAdminSecret`, `deriveDocKeys`,
`deriveMetaRoomPassword`, `encryptSubdoc`,
`decryptSubdoc`, `generateIdentityKeypair`,
`ed25519KeyPairFromSeed`, `signBytes`,
`verifyBytes`, `base64urlEncode`, `bytesToHex`,
`hexToBytes`, `DocKeys`, `Ed25519KeyPair`

## @pokapali/capability — All Stable

`encodeFragment`, `decodeFragment`, `buildUrl`,
`parseUrl`, `inferCapability`, `narrowCapability`,
`CapabilityKeys`, `Capability`, `ParsedUrl`,
`CapabilityGrant`, `DocKeys`

## @pokapali/snapshot — Mostly Stable

**Stable:** `encodeSnapshot`, `decryptSnapshot`,
`decodeSnapshot`, `validateSnapshot`, `walkChain`,
`SnapshotNode`, `CID`, `sha256`, `dagCborCode`

**Internal:** Fetch coalescer exports (will be
removed in 0.2.0)

## @pokapali/subdocs — All Stable

`createSubdocManager`, `SubdocManager`,
`SubdocManagerOptions`, `SNAPSHOT_ORIGIN`

## @pokapali/sync — Mostly Internal

Consumed by `@pokapali/core`. Re-exports `Awareness`
(from `y-protocols`) and `SubdocManager` (from
`@pokapali/subdocs`) for consumer convenience.
All other exports are internal.

## @pokapali/log — All Stable

`createLogger`, `setLogLevel`, `getLogLevel`,
`Logger`, `LogLevel`

## @pokapali/node

**Stable:** `createPinner`, `startRelay`,
`startHttpServer`, `PinnerConfig`, `Pinner`,
`RelayConfig`, `Relay`, `HttpConfig`

**Experimental:** `PinnerMetrics`, `encodeNodeCaps`,
`decodeNodeCaps`, `NodeCapabilities`, `NodeNeighbor`

**Internal:** Rate limiter, history tracker, and
related types

## @pokapali/comments — All Experimental

`comments()`, `Comments<T>`, `Comment<T>`, `Anchor`,
`ResolvedAnchor`, `anchorFromRelativePositions()`

Note: `createAnchor()` is a method on `Comments<T>`,
not a module-level export.

## @pokapali/test-utils — All Experimental

`createTestNetwork()`, `TestNetwork`, `TestPeer`,
`TestNetworkOptions`
