---
'@mawesome/pr-baseline': minor
'@mawesome/pr-baseline-action': minor
---

`refresh-pr-statuses` no longer covers every open PR: the new `--scope` defaults to `corrections`, the PRs showing green, which a forward baseline move is the only thing that can turn red. `unstamped` is the adoption backfill and `all` is the old behaviour, forced automatically after a forced move, with an off-base baseline, or with a custom reporter.

Also: a refresh that stops on a budget having written something is paused rather than failed, so the step stays green and the next run continues; the generated compare link names the base branch instead of the baseline commit, so a move no longer rewrites every failing status; `statusMatches` becomes `compareStatus`; `report` breaks the open PRs into passing, failing, other and unstamped; a move on a base-branch push runs no refresh when no ref changed; and the refresh logs a plan, progress and a closing summary.
