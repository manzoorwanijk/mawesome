---
'@mawesome/dependency-audit': minor
---

Add a filesystem-agnostic core so the audit can run outside Node (e.g. a browser
playground). All filesystem access goes through a new `FileSystem` port; `node:module` is
dropped (Node builtins are hardcoded). A new `@mawesome/dependency-audit/browser` entry
exports `auditPackage(fs, root, { provider, workDir })`, `createMemoryFileSystem()`, and
the `FileSystem`/`WritableFileSystem` types — with no `node:fs`/`os`/`module` or `pacote`
(the only `node:` import is `node:path`, aliased to `path-browserify` by bundlers). The
Node `audit(target)` API is unchanged: it now wraps the shared core with acquisition and a
temp dir.
