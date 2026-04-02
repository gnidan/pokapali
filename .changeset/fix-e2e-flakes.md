---
---

Fix flaky E2E tests: replace unreliable mouse-drag
selection with keyboard-based selection, add
waitForPeerConnection before concurrent edits,
add waitForRelayConnection for tier badge tests,
increase tier/publish timeouts, cap local Playwright
workers at 2 to prevent relay contention.
