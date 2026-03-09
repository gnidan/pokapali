# @pokapali/snapshot

> **This package is not published to npm.** It is under
> active development and not yet ready for production use.

Snapshot encoding, decoding, verification, and chain
walking for Pokapali's IPFS persistence layer. Each
snapshot is a DAG-CBOR block containing the full encrypted
state of every subdocument, linked into an append-only
chain via `prev` CID pointers. Snapshots are signed with
Ed25519 for structural validation by pinners.

## Key Exports

- **`encodeSnapshot(plaintext, readKey, prev, seq, ts,
  signingKey)`** — encrypts subdoc state and produces a
  signed DAG-CBOR block
- **`decodeSnapshot(bytes)`** — parses a block into a
  `SnapshotNode`
- **`decryptSnapshot(node, readKey)`** — decrypts the
  subdoc payloads
- **`validateStructure(block)`** — verifies CBOR schema
  and Ed25519 signature (no key authorization check)
- **`walkChain(tipCid, getter)`** — async iterator that
  follows `prev` links
- **`SnapshotNode`** — interface: `subdocs`, `prev`,
  `seq`, `ts`, `signature`, `publicKey`

Also re-exports `CID`, `sha256`, and `dagCborCode` for
convenience.

## Links

- [Root README](../../README.md)
- [Architecture — Snapshot Chain](../../docs/architecture.md)
