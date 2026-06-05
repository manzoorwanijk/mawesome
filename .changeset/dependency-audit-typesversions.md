---
'@mawesome/dependency-audit': patch
---

Apply `typesVersions` to the target's type-entry discovery (for the current TypeScript
version) when `exports` is absent. A matching mapping with a `"*"` catch-all (the dominant
`{"*":{"*":["dist/*"]}}` pattern) is treated as authoritative: the type surface is scoped to
its target dir, so sibling/older-TS-version directories that whole-tarball scanning would
otherwise over-include are excluded — removing that false-positive class. Non-catch-all
mappings are additive (their targets are scanned alongside the tarball, never restricting
it). `exports`-governed packages still ignore `typesVersions`, matching TypeScript. The
per-consumer-TS-version matrix remains deferred; dependency-side `typesVersions` was already
handled by the TypeScript resolver.
