---
"@pokapali/react": minor
---

Add `{localOnly?: boolean}` option to
`useSnapshotFlash`. Since S54, `snapshotEvents` fires
for peer-received snapshots with `isLocal: false`,
fulfilling the existing API contract. Consumers that
flash on every event may see rate increases in
catch-up scenarios; pass `{localOnly: true}` to
restore pre-S54 behavior (flash only on local
publish), or debounce in userland if noise-sensitive.
