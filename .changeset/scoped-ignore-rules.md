---
'@mawesome/dependency-audit': minor
---

Ignore rules can now be scoped with `target` (an audited package name or target spec) and `path` (a glob over the finding's `firstSeenIn`), so a localized suppression no longer hides the same specifier in another package.
