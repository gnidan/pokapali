---
"@pokapali/core": patch
"@pokapali/sync": patch
---

Fix signature enforcement gaps: empty trustedKeys set now
rejects all signers instead of being permissionless, and
coordinator calls verifySig callback on signed edits during
reconciliation instead of accepting them unverified.
