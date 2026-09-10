# Permissions

## What each command needs

| Command               | `contents` | `statuses`                         | `pull-requests` | Why                                                                                       |
| --------------------- | ---------- | ---------------------------------- | --------------- | ----------------------------------------------------------------------------------------- |
| `refresh-pr-status`   | read       | write                              | read for `--pr` | Reads the baseline refs and compares commits; writes one status; reads the PR for `--pr`. |
| `refresh-pr-statuses` | read       | write                              | read            | Lists open PRs through GraphQL, compares commits, writes statuses.                        |
| `move-baseline`       | **write**  | write with `--refresh-pr-statuses` | read            | Creates or moves the baseline ref; lists merged PRs by label.                             |
| `report`              | read       | read                               | read            | Read-only; the PR listing includes each head's current status.                            |

Everything else is denied. In a workflow, set `permissions: {}` at the top level and grant these per job.

## Per token type

| Token            | Creator               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`   | `github-actions[bot]` | The action proves the token is the workflow's own and resolves the creator without a request. The git adapter presents the same token to an https remote on every fetch, so a checkout with `persist-credentials: false` is enough. From the CLI, pass `--creator 'github-actions[bot]'`, because `GET /user` is not available to an installation token. Events it creates trigger no other workflows, so the refresh must run in the same job as the baseline move. |
| Fine-grained PAT | the user's login      | Needs Contents read (write for `move-baseline`), Commit statuses write, Pull requests read on the repository. The creator is resolved through `GET /user`.                                                                                                                                                                                                                                                                                                           |
| GitHub App       | `<app-slug>[bot]`     | Same permissions as the PAT, granted to the installation. Pass `creator` explicitly; the tool refuses to guess, and a mismatch between the resolved creator and the login GitHub reports on a write fails the run.                                                                                                                                                                                                                                                   |

## Ruleset setup

1. **Require the status context** (`PR baseline` by default) in the base branch's ruleset only. Requiring it on other branches shows "Expected" forever, because the tool writes nothing for PRs against them by default.
2. Set the ruleset's **status source** to match the token: "GitHub Actions" for `GITHUB_TOKEN`, the App for an App token, any source for a PAT. The refresh rewrites a status written by another creator, so the configured token always satisfies the pinned source.

## Who can move a baseline

The baseline refs live under `refs/baselines/`, a namespace rulesets do not cover, so whoever holds `contents: write` on the repository can move or delete them, exactly like any unprotected ref. The tool itself only ever fast-forwards them. That is the trade for refs that never disturb a developer's `git pull`; if a server-side rule is a requirement, keep the move path to the workflow's own token (`contents: write` granted to the one job) and give maintainers a dispatch rather than a PAT.

Follow the [runbook](./runbook.md) for the order of operations: seed, let the refresh converge, verify with `report`, then require the context.
