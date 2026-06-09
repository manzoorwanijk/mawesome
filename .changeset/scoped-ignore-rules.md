---
'@mawesome/dependency-audit': minor
---

Ignore rules can now be scoped to a `target` (package name or spec) and/or `path` (a `firstSeenIn` glob), so a localized suppression no longer hides the same specifier elsewhere.
