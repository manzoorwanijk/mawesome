# pr-baseline documentation

Reference documentation for `@mawesome/pr-baseline`, a tool that keeps open pull requests current with a movable **baseline** on the base branch, reported through commit statuses.

## Contents

- [Concepts](./concepts.md): the baseline, verdicts, scope, and how a baseline moves.
- [CLI reference](./cli.md): every command, flag and exit code.
- [Programmatic API](./api.md): `createClient`, the `Ancestry` and `Reporter` ports, result types.
- [Permissions](./permissions.md): what each token type needs and how to set up the rulesets.
- [Rate limits](./rate-limits.md): what each command costs and how the tool paces itself.
- [Edge cases](./edge-cases.md): forks, other base branches, stacked PRs, races, absent tags.
- [Runbook](./runbook.md): rollout order, retries, rollback and what "Expected" means.
- [For PR authors](./for-pr-authors.md): the one paragraph a blocked author needs.
- [GitHub Action](./action.md): inputs, outputs and the consumer workflow (lands with the action).

## One-paragraph summary

A lightweight tag on the base branch marks the last commit every open PR must contain. `check` evaluates one commit and writes a `success` or `failure` status; `sweep` does the same for every open PR against the base branch, writing only what changed; `move-baseline` advances the tag when a labeled PR merged, a marker path changed on the base branch, or an operator forces it, and can sweep afterwards; `report` shows where everything stands. A missing tag means nothing is required yet, so adoption is safe, and the tag never moves backwards through the tool.
