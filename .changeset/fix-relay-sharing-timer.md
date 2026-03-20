---
"@pokapali/core": patch
---

Fix relay-sharing timer firing after test cleanup.
Add destroyed guard to publishRelays and
onAwarenessUpdate callbacks so they no-op after
destroy(). Fix incomplete peer-discovery mock in
index.test.ts to include relayEntries and
addExternalRelays.
