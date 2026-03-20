# Changesets

This project uses [changesets](https://github.com/changesets/changesets)
to manage versioning and changelogs.

## Adding a changeset

Every PR that modifies code in `packages/` or `apps/`
should include a changeset file:

```
npx changeset
```

Follow the prompts to select affected packages and
describe the change. The description becomes the
changelog entry — write it for consumers.

## Bump levels

- **patch** — bug fixes, new features (pre-1.0)
- **minor** — breaking changes (pre-1.0)

See `docs/api-stability.md` for the full versioning
policy.
