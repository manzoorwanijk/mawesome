---
'@mawesome/pr-baseline': minor
'@mawesome/pr-baseline-action': minor
---

`refresh-pr-statuses` now covers only the PRs a baseline move can have turned red, the ones showing green, with `--scope unstamped` and `--scope all` for the rest. Breaking: `statusMatches` becomes `compareStatus`, a budget stop that made progress is a pause rather than a failure, and several result fields are new or changed meaning.
