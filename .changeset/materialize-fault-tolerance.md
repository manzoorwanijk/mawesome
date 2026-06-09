---
'@mawesome/dependency-audit': patch
---

Fix non-deterministic false findings on large batches: a transient registry fetch is now retried, and a dependency that still can't be fetched fails its target instead of being reported as an undeclared import. Adds `--concurrency` to tune fan-out.
