---
"@pokapali/core": patch
---

Wire envelope verification into incoming reconciliation
path. Edits arriving with 97-byte signed envelopes are
verified against the trusted key set before application;
edits with raw/legacy signatures pass through unchanged
for mixed-version peer compatibility. Fire-and-forget
signing promises now include .catch() for observability.
