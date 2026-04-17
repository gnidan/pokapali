---
"@pokapali/core": minor
---

Add `BlockResolver.has(cid): boolean` sync availability
check and ship a reusable test harness for consumers.

- `has()`: synchronous availability probe (memory ∪
  persistence tiers). Required for hot-path filters
  (catalog advertise, REQUEST responders) that cannot
  await. May return true while `getCached()` returns
  null — persisted-but-evicted blocks remain `has()`-
  available and fetchable via async `get()`.
- Transitional impl in `createBlockResolver` reflects
  memory only; the real layered resolver lands in
  `@pokapali/protocol` (S54 A2) with IDB-backed
  `knownCids` mirror for full persistence-tier
  reflection.

New test utility in `packages/core/src/test/`:

- `createStubBlockResolver()`: two-tier in-memory stub
  honoring the full `BlockResolver` contract, plus
  inspection surface (`storedCids`, `memoryOnlyCids`,
  `putCount`, `getCachedCount`) and test-controlled
  scenario hooks (`simulateMemoryEviction`,
  `simulateBlockLoss`, `simulatePutFailure`,
  `simulatePersistentPutFailure`). Shared fixture for
  S54 A3 (ingest) and A4 (wiring) tests; a parity test
  against the real impl lives with A2 in protocol.
- `cidMatchesBlock()`: convenience CID/block hash
  check for transfer-integrity assertions.

Stub-sync policy: any future change to the
`BlockResolver` interface must update the stub in the
same PR. Stub-vs-real divergence surfaces as a parity-
test build break.
