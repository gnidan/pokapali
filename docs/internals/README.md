# Internals

Developer documentation for contributors and anyone
who wants to understand how pokapali works under the
hood. These docs describe the implementation — for
consumer-facing API documentation, see the
[guide](../guide.md) and
[API stability tiers](../api-stability.md).

## Start here

- **[Design Principles](principles.md)** — the
  architectural values behind pokapali: capability
  URLs, zero-knowledge pinning, fact-stream state
  management, local-first editing, and network
  patience.

## Architecture

The [architecture reference](architecture.md) is the
main design document, organized into topic guides:

| Topic                   | What it covers                                       |
| ----------------------- | ---------------------------------------------------- |
| [State management][sm]  | Fact-stream architecture, reducers, interpreter loop |
| [Channels & sync][ch]   | Subdocument isolation, WebRTC rooms, channel keys    |
| [Persistence & IPNS][p] | Snapshot encoding, IPNS publishing, block storage    |
| [Infrastructure][inf]   | Relay, pinner, HTTP endpoints, deployment            |
| [Security][sec]         | Encryption, key derivation, access control           |
| [Signaling][sig]        | GossipSub signaling, peer discovery, DHT             |

[sm]: architecture/state-management.md
[ch]: architecture/channels.md
[p]: architecture/persistence.md
[inf]: architecture/infrastructure.md
[sec]: architecture/security.md
[sig]: architecture/signaling.md

## Security

- **[Security Design](security-design.md)** —
  announcement authentication and publisher binding
  (covers issues #75 and #76).
- **[Security Model](../security-model.md)** —
  consumer-facing security documentation (capability
  URLs, encryption, trust model, identity, recovery).

## Reference

- **[Dependencies](deps.md)** — dependency versioning
  decisions and rationale for every major dependency.
