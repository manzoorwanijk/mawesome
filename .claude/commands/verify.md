---
description: Run the full local verification gate and report a tidy pass/fail summary
---

Run the monorepo's full verification gate and report the result.

Steps:

1. Run `pnpm verify` from the repo root. This runs, in order: lint (oxlint),
   format:check (oxfmt), deps:lint (syncpack), check:root-deps, typecheck (tsgo),
   test (vitest), build (tsdown), check:exports (attw + publint).
2. If it fails, identify which step failed from the output and report the specific
   errors. Suggest the fix (e.g. `pnpm format` to fix formatting, `pnpm deps:fix` for
   dependency mismatches, `pnpm lint:fix` for autofixable lint issues).
3. Summarize as a short pass/fail checklist, one line per stage.

Do not modify files unless the user asks you to fix the failures.
