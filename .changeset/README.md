# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).

Every change that affects a published `@mawesome/*` package needs a changeset:

```sh
pnpm changeset
```

Pick the affected package(s) and the bump type (patch / minor / major), then write a short, user-facing summary — it becomes the package's changelog entry. Commit the generated file in `.changeset/` alongside your change.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full release flow.
