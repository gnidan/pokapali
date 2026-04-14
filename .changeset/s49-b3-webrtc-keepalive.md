---
"@pokapali/sync": patch
---

Add WebRTC data channel keepalive (ping-pong)

Send 1-byte PING every 20s on idle reconciliation data
channels to prevent NAT/firewall timeout. Auto-respond
to PING with PONG. Keepalive frames are handled below
the reconciliation message layer and never bubble to
coordinators.
