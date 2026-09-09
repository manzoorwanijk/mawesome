# pr-baseline documentation

Reference documentation for `@mawesome/pr-baseline`, a tool that keeps open pull requests current with a movable **baseline** on the base branch, reported through commit statuses.

## Contents

- [Concepts](./concepts.md): the baseline, why it is not a tag, verdicts, scope, and how a baseline moves.
- [CLI reference](./cli.md): every command, flag and exit code.
- [Programmatic API](./api.md): `createClient`, the `Ancestry` and `Reporter` ports, result types.
- [Permissions](./permissions.md): what each token type needs and how to set up the rulesets.
- [Rate limits](./rate-limits.md): what each command costs and how the tool paces itself.
- [Edge cases](./edge-cases.md): forks, other base branches, stacked PRs, races, absent baselines.
- [Runbook](./runbook.md): rollout order, retries, rollback and what "Expected" means.
- [For PR authors](./for-pr-authors.md): the one paragraph a blocked author needs.
- [GitHub Action](./action.md): the workflow to copy, every input and output, how events map to commands and the release to the mirror.

## One-paragraph summary

A ref under `refs/baselines/` on the base branch marks the last commit every open PR must contain. `refresh-pr-status` evaluates one commit and writes a `success` or `failure` status; `refresh-pr-statuses` does the same for every open PR against the base branch, writing only what changed; `move-baseline` advances the ref when a labeled PR merged, a marker path changed on the base branch, or an operator forces it, and can refresh afterwards; `report` shows where everything stands. A missing baseline means nothing is required yet, so adoption is safe, and a baseline never moves backwards through the tool.
