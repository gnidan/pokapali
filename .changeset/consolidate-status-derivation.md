---
"@pokapali/core": patch
---

#382 Consolidate status derivation: deriveStatus() is now the single source of truth in doc-status.ts with all 7 branches (including MESH_GRACE_MS). computeStatus() delegates to it.
