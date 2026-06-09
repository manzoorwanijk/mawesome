---
'@mawesome/dependency-audit': minor
---

When a package ships no types and has no `@types/*` companion but a published version ships its own types, the finding now names that version ("depend on `x@2.0.0`") instead of the dead-end `types-unavailable`.
