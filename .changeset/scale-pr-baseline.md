---
'@mawesome/pr-baseline': minor
'@mawesome/pr-baseline-action': minor
---

`refresh-pr-statuses` no longer visits every open PR: the new `--scope` defaults to `corrections`, the PRs showing green, which a forward baseline move is the only thing that can turn red, and `unstamped` and `all` cover the rest. Breaking: `statusMatches` is replaced by `compareStatus`, a refresh that stops on a budget having written something is a pause that exits 0 with `incomplete` still true, and the result and action outputs gain `scope`, `selected`, `excluded`, `cosmetic`, `remaining`, `paused`, `moved` and `moved-baselines`.
