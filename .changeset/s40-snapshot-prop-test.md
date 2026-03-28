---
"@pokapali/document": patch
---

Add property test for appendSnapshot tree invariants:
verifies epoch boundaries, edit counts, and epoch
counts hold after arbitrary interleaving of
appendEdit, closeEpoch, and appendSnapshot.
