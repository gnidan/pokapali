---
---

Add release branch infrastructure.
verify-branch.sh accepts --base flag for targeting
release/_ branches instead of main. Pre-commit hook
guards release/_ branches the same as main. CI and
publish workflows trigger on release/\*\* branches.
