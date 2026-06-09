---
'@mawesome/dependency-audit': patch
---

`Finding.causedBy` now carries the producer's `packageName` alongside its `target`, so a JSON consumer can correlate producers by name without parsing the target spec.
