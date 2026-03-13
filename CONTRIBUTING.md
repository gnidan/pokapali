# Contributing

## Lockfile Conflicts

`package-lock.json` conflicts are common when merging
branches that added or updated dependencies. The lockfile
is machine-generated and should never be manually edited.

**Recipe:**

```bash
# Accept either side (doesn't matter which)
git checkout --theirs package-lock.json
# Regenerate from package.json
npm install
# Stage and continue
git add package-lock.json
git merge --continue   # or git rebase --continue
```

## Version Bumps

Version bumps must be **single commits on main** — never
on feature branches. Use the version-bump script:

```bash
git checkout main
# Bump a single package (cascades to dependents)
bin/version-bump.mjs @pokapali/crypto 0.1.0-alpha.1
# Or use the short name
bin/version-bump.mjs crypto 0.1.0-alpha.1
# Bump all publishable packages at once
bin/version-bump.mjs --all 0.1.0-alpha.0
```

The script:

1. Validates you're on main with a clean tree
2. Updates `version` in target package(s)
3. Cascades bump to all transitive dependents
4. Updates internal `@pokapali/*` dependency versions
5. Runs `npm install` to sync the lockfile
6. Creates a single commit
7. Creates per-package git tags (`publish/<dir>/<version>`)

## Publishing

Packages are published to npm under the `@pokapali` scope.
Private packages (`load-test`, `example`) are never
published.

**Automated (preferred):** Push tags created by the
version-bump script. Each tag triggers a GitHub Actions
workflow that builds, tests, and publishes that package.

```bash
# After version-bump.mjs, push commit + tags
git push origin main publish/core/0.1.0-alpha.1 ...
```

**Manual dispatch:** Trigger from the Actions tab using
`workflow_dispatch` with a package name and version.

**Manual CLI:**

```bash
npm publish -w packages/core --access public
```
