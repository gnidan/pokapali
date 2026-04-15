---
"@pokapali/core": patch
"@pokapali/react": patch
---

Guard awareness room swap on relay reconnect

Only swap the awareness room when the current room
is disconnected. When multiple relays reconnect in
rapid succession (e.g. after idle resume), the
previous swap-on-every-reconnect behavior tore down
peer connections before they finished establishing,
leaving the user stuck on "Just you."

Also replaces the blind 5-second settling timer in
usePeerPresenceState with awareness-driven logic:
settle after 2s when WebRTC is established (synced),
or 10s max when only gossip is active (receiving).
