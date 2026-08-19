---
'@mawesome/dependency-audit': patch
---

Static imports in `.js` ESM bundles are now scanned even when the package has no `"type": "module"`, so their undeclared runtime dependencies are reported.
