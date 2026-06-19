---
'@mawesome/dependency-audit': patch
---

Document quoting glob targets (e.g. `"./packages/*"`) in scripts so the CLI, not the shell, expands them — keeping the command portable across shells, including Windows.
