---
"@pokapali/core": patch
---

#286 Verify CID hash of blocks fetched from pinner
HTTP tip endpoints. Rejects blocks whose content does
not match the claimed CID, preventing acceptance of
tampered or corrupted data.
