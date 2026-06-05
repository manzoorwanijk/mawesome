---
'@mawesome/dependency-audit': minor
---

Add a config / ignore layer to suppress intentional findings (optional/plugin imports, known false positives). Rules match a finding by any of `package`, `specifier`, `surface`, or `kind` (an empty rule matches nothing). Supply them via repeatable `--ignore <value>` (matches by package or exact specifier), a JSON config (`./dependency-audit.config.json` by default, or `--config <path>`), or the programmatic `audit(target, { ignore })` / `auditPackage(..., { ignore })` option. Suppressed findings do not fail the audit but are surfaced in a new `result.ignored` bucket (and printed as `– ignored`), so suppressions stay auditable.
