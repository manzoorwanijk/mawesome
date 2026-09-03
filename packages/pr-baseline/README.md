# @mawesome/pr-baseline

> Keep open pull requests current with a movable baseline on the base branch.

A repository-wide change lands on `main` (a toolchain bump, a lint rule, a CI fix) and every open PR that was branched before it keeps passing CI on stale code. `pr-baseline` marks that commit with a lightweight tag, the **baseline**, and stamps every open PR with a commit status: `success` when the PR's head contains the baseline, `failure` when it does not. Require the status in the base branch's ruleset and stale PRs must merge or rebase before they can land.

The baseline moves forward only by intent: a workflow dispatch, a merged PR carrying a label, or a push touching marker paths. When it moves, a **sweep** re-evaluates every open PR and writes only the statuses that changed.

📚 Full documentation lives in [`docs/`](./docs/): [CLI](./docs/cli.md), [API](./docs/api.md), [permissions](./docs/permissions.md), [rate limits](./docs/rate-limits.md), [edge cases](./docs/edge-cases.md), [runbook](./docs/runbook.md).

## Install

```sh
pnpm add -D @mawesome/pr-baseline
```

## CLI

```sh
export GITHUB_REPOSITORY=owner/name GITHUB_TOKEN=...

# Evaluate a PR head and write its status, or ask about a commit without writing
pr-baseline check --pr 42
pr-baseline check <sha>

# Seed or move the baseline, then bring every open PR up to date
pr-baseline move-baseline --force --sweep

# Move only when a labeled PR merged or a marker path changed, then sweep
pr-baseline move-baseline --sweep

# Preview a sweep without writing anything
pr-baseline sweep --dry-run

# What is the current state?
pr-baseline report
```

Exit codes: `0` pass or complete, `1` fail or incomplete, `2` error.

Several baselines, each with its own tag, label, PR scope and auto-move markers, are configured with `--baselines`:

```sh
pr-baseline sweep --baselines '[
  { "tag": "pr-baseline", "label": "Require PR update", "markers": [".nvmrc"] },
  { "tag": "baseline/web", "scope": ["apps/web/"], "markers": ["apps/web/package.json"] }
]'
```

## Programmatic API

```ts
import { createClient } from '@mawesome/pr-baseline';

const client = createClient({ repo: 'owner/name', token: process.env.GITHUB_TOKEN });
const result = await client.check({ pr: 42 });
console.log(result.verdict.kind, result.verdict.missing);
```

See [docs/api.md](./docs/api.md) for the ports that let you swap the ancestry source, the reporter or `fetch`.

## License

[MIT](../../LICENSE) © 2026 Manzoor Ahmad Wani
