---
'@mawesome/dependency-audit': minor
---

Add `--collapse-root-cause`: in a multi-target run, a finding whose root cause is another audited target (a producer with a coverage notice) no longer fails the run — it's listed muted and counted as `collapsed`, so you fix the one producer instead of every consumer.
