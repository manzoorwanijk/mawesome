---
'@mawesome/dependency-audit': patch
---

Undeclared type findings no longer suggest a nonexistent `@types/*` package — when the registry probe reports the companion absent, the advice names only the package itself.
