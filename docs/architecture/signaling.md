# Signaling & Discovery

## Signaling

y-webrtc requires signaling to broker WebRTC
connections (SDP/ICE exchange). Signaling never sees
document content. Once signaling exchanges SDP/ICE,
WebRTC connections are direct peer-to-peer.

**Primary: GossipSub via Helia/libp2p.** Each peer
runs a Helia node with `@chainsafe/libp2p-gossipsub`
as a pubsub service. The GossipSub signaling adapter
(`packages/sync/src/gossipsub-signaling.ts`) implements
the y-webrtc `SignalingConn` interface by extending
`lib0/observable.Observable`. It registers in y-webrtc's
`signalingConns` map under `"libp2p:gossipsub"`.

All rooms share a single GossipSub topic
(`/pokapali/signaling`); room routing happens via the
room name in the JSON payload. This avoids per-room
topic overhead and keeps mesh health simple.

GossipSub is configured with `floodPublish: false` and
mesh routing:

- Browsers: D=3, Dlo=2, Dhi=6, Dout=1, Dscore=1
- Relays: D=3, Dlo=2, Dhi=8

Periodic re-announce (every 15s) ensures late-joining
peers discover existing rooms.

## Relay Discovery

Relay nodes (`@pokapali/node`) subscribe to the
signaling topic, the peer discovery topic, and
announcement topics for configured `pinAppIds`. They
forward messages between browsers via the GossipSub
mesh. Relays use autoTLS for automatic WSS certificate
provisioning, and run client-mode DHT to provide
records without serving DHT queries.

Browsers discover relays via:

1. **DHT** — looking up a network-wide CID derived
   from `sha256("pokapali-network")` (not per-app or
   per-document)
2. **Cached relay addresses** in `localStorage` (24h
   TTL, 48h max age)
3. **Peer exchange** — connected peers share relay
   addresses via the awareness channel

**No relay addresses are hardcoded.** On startup,
browsers try cached relays first (fast direct dial)
then run DHT discovery in parallel.

Relay caching logic is in `relay-cache.ts` (extracted
from `peer-discovery.ts` for testability). Discovery
uses a 30s FIND_TIMEOUT with 15s startup retry.

## Bootstrap

The only hardcoded addresses are IPFS bootstrap nodes
(Protocol Labs public infrastructure) — needed for
initial DHT entry but not pokapali-specific. Once
connected to the DHT, all further discovery is organic.

Browser-side Helia bootstrap has a 30s timeout to
prevent indefinite hangs if all bootstrap peers are
unreachable.

Two browsers sharing the same document URL can
collaborate with zero self-hosted infrastructure —
only public IPFS/libp2p bootstrap nodes are needed.

## Delegated Routing

Delegated routing defaults to `delegated-ipfs.dev`,
Protocol Labs' public infrastructure. Self-hostable
via `someguy` if operational independence is required.

## GossipSub Topics

| Topic                                   | Purpose                                                   | Subscribers            |
| --------------------------------------- | --------------------------------------------------------- | ---------------------- |
| `/pokapali/signaling`                   | y-webrtc room signaling                                   | All peers              |
| `/pokapali/app/{appId}/announce`        | Snapshot announcements, acks, guarantee queries/responses | All peers for that app |
| `pokapali._peer-discovery._p2p._pubsub` | Peer discovery                                            | All peers              |
| `pokapali._node-caps._p2p._pubsub`      | Node capability broadcasting                              | All peers              |

## GossipSub Configuration

| Parameter                  | Browsers | Relays              |
| -------------------------- | -------- | ------------------- |
| `floodPublish`             | false    | false               |
| `D`                        | 3        | 3                   |
| `Dlo`                      | 2        | 2                   |
| `Dhi`                      | 6        | 8                   |
| `Dout`                     | 1        | —                   |
| `Dscore`                   | 1        | —                   |
| `maxOutboundBufferSize`    | 10MB     | 10MB                |
| `IPColocationFactorWeight` | 0        | 0                   |
| `appSpecificScore`         | —        | 100 for relay peers |

`IPColocationFactorWeight: 0` because browser peers
connect via p2p-circuit through relay IPs, triggering
false positives.

`appSpecificScore: 100` for relay peers ensures
relay-to-relay connections are preferred for GossipSub
mesh grafting.
