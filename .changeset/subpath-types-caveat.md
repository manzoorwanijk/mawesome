---
'@mawesome/dependency-audit': patch
---

A subpath `missing-types` finding now qualifies its suggestion to note the `@types/*` companion or typed version may not declare that exact subpath, pointing to a local ambient `declare module` as the fallback.
