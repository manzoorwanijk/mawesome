---
'@mawesome/dependency-audit': minor
---

In a multi-target run, a finding whose package is itself an audited target with a coverage notice is now annotated with `causedBy`, pointing every consumer at the one producer to fix instead of N look-alike findings.
