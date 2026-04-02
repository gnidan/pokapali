---
---

Fix E2E test failures on CI:

- Isolate concurrent CI runs: PID-based Vite port and
  relay info file path prevent collisions on shared VPS
- Add waitForDocSync canary: verify actual CRDT sync
  (not just GossipSub awareness) before typing
- Replace mouse-drag selection with keyboard-based
  selection for headless Chromium reliability
- Add waitForRelayConnection for tier badge tests
- Add retry logic for relay info file loading
- Increase timeouts for CI (60s base, 45s publish)
- Disable reuseExistingServer on CI
- Cap workers at 2 local / 1 CI
