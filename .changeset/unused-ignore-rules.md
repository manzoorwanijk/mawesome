---
'@mawesome/dependency-audit': minor
---

Warn about stale ignore rules: a rule that matched nothing across the run is reported on stderr, `--fail-unused-ignores` turns that into a failure, and `AuditResult` gains `usedIgnoreRules` for programmatic consumers.
