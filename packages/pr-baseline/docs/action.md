# GitHub Action

The action ships in a later phase of this package. It will be one root action with a `mode` input (`auto|check|sweep|move-baseline|report`), inputs mirroring the [CLI](./cli.md), outputs for every result field, and a copyable consumer workflow with two jobs: a `check` job on pull request and merge queue events, and a `sweep` job on base pushes, labeled merges, a schedule and a workflow dispatch.

Until then, run the CLI from a workflow:

```yaml
- run: npx @mawesome/pr-baseline sweep --creator 'github-actions[bot]'
  env:
    GITHUB_REPOSITORY: ${{ github.repository }}
    GITHUB_TOKEN: ${{ github.token }}
```

`--creator` is required with `GITHUB_TOKEN` from the CLI because an installation token cannot answer `GET /user`; the action resolves it automatically. See [permissions](./permissions.md) for the job permissions each command needs.
