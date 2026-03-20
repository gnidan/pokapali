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

## Changesets

Every PR must include a changeset file describing the
change. Run `npx changeset` and follow the prompts to
select affected packages and bump type (patch/minor).

For non-package changes (CI, docs, scripts), create a
changeset with empty frontmatter:

```markdown
---
---

Description of the change.
```

## Releasing

Releases are cut from main using `bin/release.sh`.
The script runs `changeset version` to compute bumps,
generates CHANGELOG entries, and creates a single
release commit. Pushing to GitHub triggers
`publish.yml`, which runs `changeset publish` to
publish bumped packages to npm and push per-package
git tags.

```bash
bin/release.sh
```

**Manual dispatch:** If `publish.yml` needs re-running,
trigger from the GitHub Actions tab via
`workflow_dispatch`.

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
