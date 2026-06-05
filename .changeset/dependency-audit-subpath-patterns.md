---
'@mawesome/dependency-audit': patch
---

Expand `exports` subpath patterns (`"./*"`) during entry discovery on both surfaces. Wildcard export targets (e.g. `"./*": { "import": { "types": "./lib/*.d.ts", "default": "./lib/*.js" } }`) are now matched against the package's actual files (`*` spans `/`, per Node), so packages that expose their API only through a pattern export are no longer under-scanned.
