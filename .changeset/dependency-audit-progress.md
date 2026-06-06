---
'@mawesome/dependency-audit': minor
---

Show a live progress indicator on stderr while auditing (current phase and deps materialized), so a long run no longer looks hung. It only renders on an interactive terminal, so `--json` and redirected output stay clean; pass `--no-progress` (or set `NO_PROGRESS`) to suppress it.
