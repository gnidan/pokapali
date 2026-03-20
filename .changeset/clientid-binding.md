---
"@pokapali/core": patch
---

#252 Bind clientID into identity signature payload.

v2 signature format signs `pubkey:clientID:ipnsName`
instead of `pubkey:ipnsName`, preventing replay of a
valid identity entry under a different clientID.

Entries gain an optional `v: 2` field for dual
verification — old clients degrade gracefully
(show v2 entries as unverified).
