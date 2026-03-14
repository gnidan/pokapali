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

## Deploying Relays

Relay nodes are deployed via GitHub Actions. The
workflow reads node configuration from
`deploy/nodes.json` and deploys in rolling batches
with health checks between each batch.

**Automated (preferred):** Trigger from the Actions
tab → "Deploy Relays" → Run workflow.

Inputs:

- **commit** — target SHA (default: latest main)
- **skip_nodes** — comma-separated names to exclude
- **dry_run** — log commands without executing

**Node configuration:** Edit `deploy/nodes.json` to
add, remove, or reorder nodes. Each batch deploys
in parallel; batches run sequentially with health
checks between them.

```json
{
  "batches": [
    {
      "name": "batch-1",
      "nodes": [{ "name": "chi", "host": "1.2.3.4", "role": "pinner" }]
    }
  ]
}
```

**Rollback:** Re-run the workflow with the previous
commit SHA. The workflow logs each node's current
commit at the start for reference.

**First-time setup:** Run the setup script to
generate a deploy key, install it on all nodes,
and configure GH secrets:

```bash
bin/deploy-setup.sh
```

This uses `gh` CLI to set `DEPLOY_SSH_KEY` and
`DEPLOY_KNOWN_HOSTS` secrets programmatically.
Requires `gh` auth and SSH access to all nodes.

Node config (`deploy/nodes.json`) is stored in the
`DEPLOY_NODES_CONFIG` secret. Update it with:

```bash
cat deploy/nodes.json | gh secret set DEPLOY_NODES_CONFIG
```

**Manual deploy** (if GHA is unavailable):

```bash
bin/deploy-node.sh root <ip> /opt/pokapali \
  pokapali-node <commit>
bin/health-check.sh root <ip> /opt/pokapali \
  pokapali-node <commit> 3000 15 4 20
```
