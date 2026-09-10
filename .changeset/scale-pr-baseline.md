---
'@mawesome/pr-baseline': minor
'@mawesome/pr-baseline-action': minor
---

`refresh-pr-statuses` no longer visits every open PR: the new `--scope` defaults to `corrections`, the PRs showing green, which a forward baseline move is the only thing that can turn red, and `unstamped` and `all` cover the rest. A refresh that stops on a budget having written something is now a pause rather than a failure, so it exits 0 with `incomplete` still true.
