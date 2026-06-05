---
'@mawesome/dependency-audit': minor
---

Initial release: verify a package's released **type (`.d.ts`)** and **runtime (JS)**
surfaces only import declared, resolvable dependencies. Audits a directory or `.tgz`,
discovers each surface from the manifest, materializes declared deps (prod/peer/optional)
fresh into one shared tree, and resolves each specifier — type specifiers via the bundled
`typescript` (with `@types/*` fallback), runtime specifiers via each dep's own
`exports`/`main` per call form (`import` vs `require`). Reports `undeclared`,
`missing-types`, and `unresolved` findings; Node builtins imply `@types/node` on the type
surface and need no declaration at runtime. Ships a `dependency-audit` CLI and an
`audit()` API with an injectable registry provider.
