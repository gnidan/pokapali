# @pokapali/blocks

```sh
npm install @pokapali/blocks
```

Snapshot encoding, decoding, verification, and chain
walking for Pokapali's IPFS persistence layer. Each
snapshot is a DAG-CBOR block containing the full encrypted
state of every subdocument, linked into an append-only
chain via `prev` CID pointers. Snapshots are signed with
Ed25519 for structural validation by pinners.

## Quick Example

```ts
import {
  encodeSnapshot,
  decodeSnapshot,
  decryptSnapshot,
  validateSnapshot,
} from "@pokapali/blocks";
import { deriveDocKeys, ed25519KeyPairFromSeed } from "@pokapali/crypto";

// Derive keys (normally done by @pokapali/core)
const keys = await deriveDocKeys(secret, "my-app", ["content"]);
const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);

// Encode a snapshot from subdoc state
const block = await encodeSnapshot(
  { content: contentBytes, _meta: metaBytes },
  keys.readKey,
  null, // prev CID (null for first snapshot)
  1, // seq
  Date.now(), // ts
  signingKey,
);

// Validate structure + signature (returns boolean)
const isValid = await validateSnapshot(block);
console.log("valid:", isValid);

// Decode and decrypt
const node = decodeSnapshot(block);
const plaintext = await decryptSnapshot(node, keys.readKey);
// plaintext.content, plaintext._meta
```

## Key Exports

- **`encodeSnapshot(plaintext, readKey, prev, seq, ts,
signingKey)`** — encrypts subdoc state and produces a
  signed DAG-CBOR block
- **`decodeSnapshot(bytes)`** — parses a block into a
  `SnapshotNode`
- **`decryptSnapshot(node, readKey)`** — decrypts the
  subdoc payloads
- **`validateSnapshot(block)`** — verifies CBOR schema
  and Ed25519 signature (no key authorization check)
- **`walkChain(tipCid, getter)`** — async iterator that
  follows `prev` links
- **`SnapshotNode`** — interface: `subdocs`, `prev`,
  `seq`, `ts`, `signature`, `publicKey`

Also re-exports `CID`, `sha256`, and `dagCborCode` for
convenience.

## Links

- [Root README](https://github.com/gnidan/pokapali#readme)
- [Architecture — Snapshot Chain](https://github.com/gnidan/pokapali/tree/main/docs/internals)
