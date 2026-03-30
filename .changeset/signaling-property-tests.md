---
"@pokapali/node": patch
"@pokapali/sync": patch
---

Add property tests for signaling framing and WebRTC
signal encoding; harden JSON.parse in decodeWebRTCSignal

Property tests verify createFrameReader reassembles
frames correctly across arbitrary chunk boundaries,
and that WebRTC signal encode/decode round-trips for
arbitrary SDP and ICE payloads.

Wraps JSON.parse in decodeWebRTCSignal with try/catch
so corrupt payloads produce a descriptive error instead
of a raw SyntaxError.
