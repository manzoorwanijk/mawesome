---
'@mawesome/dependency-audit': minor
---

Retry transient registry materialization failures and, when a dependency still can't be fetched, fail that target with an error instead of silently reporting its imports as undeclared — fixing non-deterministic false findings on large batches. Adds a `--concurrency` flag (plus `DEPENDENCY_AUDIT_CONCURRENCY` / `DEPENDENCY_AUDIT_RETRIES`) to tune fan-out and the retry budget.
