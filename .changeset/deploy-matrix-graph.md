---
---

ops: fix deploy workflow — per-batch GHA jobs

Rework deploy-relays.yml to use per-batch jobs that
each read the secret directly and deploy nodes in
parallel. Avoids GHA secret masking issue where job
outputs derived from secrets are redacted. Setup job
outputs only commit and batch count (not secret data).
New bin/deploy-batch.sh handles single-batch parallel
deploys. Supports up to 5 batches; unused auto-skip.
