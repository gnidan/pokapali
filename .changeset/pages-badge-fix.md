---
---

#345 Remove deploy-pages job from ci.yml to prevent
badge-less deploys overwriting deploy-pages.yml output.
deploy-pages.yml already handles push-to-main deploys
with badge generation. Also fixes #331 (double-build).
