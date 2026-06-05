---
'@mawesome/dependency-audit': patch
---

Use the running Node's live builtin module list instead of a static snapshot. The core keeps a hardcoded fallback (so the browser build stays free of `node:module`), but the Node `audit()` entry now injects `builtinModules`, so newly-added Node builtins are classified correctly without a release. The `builtins` option on `auditPackage` exposes the same injection point for other runtimes. Prefix-only builtins (`test`/`sqlite`/`sea`) remain matched only under the `node:` scheme regardless of the injected set.
