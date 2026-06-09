---
'@mawesome/dependency-audit': patch
---

Retry transient registry fetches and fail the target if one still can't be fetched, instead of emitting false `undeclared` findings on large batches. Adds `--concurrency` to tune fan-out.
