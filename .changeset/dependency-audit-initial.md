---
'@mawesome/dependency-audit': minor
---

Initial release: verify a package's released `.d.ts` surface only imports declared,
resolvable dependencies. Audits a directory or `.tgz`, discovers the type surface from
the manifest, materializes declared deps (prod/peer/optional) fresh, and resolves each
specifier with the bundled `typescript` — reporting `undeclared` and `missing-types`
findings (Node builtins imply `@types/node`). Ships a `dependency-audit` CLI and an
`audit()` API with an injectable registry provider.
