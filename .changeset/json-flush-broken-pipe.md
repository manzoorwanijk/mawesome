---
'@mawesome/dependency-audit': patch
---

Harden the exit flush so a broken pipe (e.g. `--json | head`) can't crash or hang the process via an `EPIPE`.
