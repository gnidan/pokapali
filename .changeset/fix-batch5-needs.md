---
---

ops: fix batch-5 needs YAML array syntax

Removes >- fold on batch-5 needs field so GHA
parses it as an array instead of a literal string.
