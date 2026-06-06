---
'@mawesome/dependency-audit': patch
---

Don't lose `--json` output on a late crash or a truncating pipe: a stray background rejection is logged (not fatal) so the run still writes its result, and exit flushes stdout first.
