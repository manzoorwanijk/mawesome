---
'@mawesome/pr-baseline': minor
'@mawesome/pr-baseline-action': minor
---

`refresh-pr-statuses` no longer visits every open PR: the new `--scope` defaults to `corrections`, the PRs showing green, which a forward baseline move is the only thing that can turn red, and `unstamped` and `all` cover the rest. Breaking: `statusMatches` is replaced by `compareStatus`; a refresh that stops on a budget having written something is a pause that exits 0 with `incomplete` still true; `RefreshPrStatusesResult.openPulls` now counts the first listing rather than the post-reconciliation set and `ReportResult.stale` no longer counts differences in wording or link alone; and both results and the action outputs gain fields for the scope, the counts and what moved.
