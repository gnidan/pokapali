---
"@pokapali/sync": minor
---

Peer connection retry + offer timeout (S53 C1).

- RTCPeerConnection "disconnected" now has a 10s
  grace period before being treated as a failure
  (WebRTC often self-recovers).
- "failed" and offer-answer timeout (10s) trigger
  retry with exponential backoff (1s / 2s / 4s,
  ±30% jitter). Up to 3 attempts.
- BEHAVIORAL CHANGE: `onPeerDisconnected` now fires
  only on terminal disconnect — retry exhaustion
  or `PEER_LEFT`. Transient state transitions are
  absorbed by the retry layer. Consumers previously
  relying on early disconnCbs firing (for example
  on every "failed") will see fewer events.
- `onPeerCreated` fires on each retry attempt.
  Consumers must re-attach per-PC state (data
  channels, event handlers) on every invocation,
  not just the first.
