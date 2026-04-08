---
"@pokapali/node": patch
---

feat(node): expose commit hash in /health endpoint

Adds a `commit` field to the /health response so
deploy scripts can verify the running process
matches the deployed code. Commit is stamped into
src/build-info.ts at build time via prebuild hook.

The deploy health check now verifies the running
process reports the expected commit, catching cases
where git checkout succeeded but service restart
failed.
