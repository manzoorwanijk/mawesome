---
description: Scaffold a new @mawesome/* package from the canonical template
argument-hint: <package-name>
---

Scaffold a new publishable `@mawesome/<name>` package. The package name is `$1` (strip any
`@mawesome/` prefix the user included).

Use the `scaffold-package` skill for the authoritative steps. In summary:

1. Validate `$1` is a valid npm package name segment (lowercase, kebab-case). If missing,
   ask the user for it.
2. Copy `templates/package/` to `packages/$1/`.
3. Replace the `PACKAGE_NAME` placeholder with `$1` in the new package's `package.json`,
   `README.md`, and `src/index.ts`.
4. Declare each dependency the package needs as a **caret range** (already older than the
   3-day `minimumReleaseAge`); reuse the **exact same range** for any dependency already used
   elsewhere in the repo. Run `pnpm deps:fix` to align versions (syncpack enforces one
   version per dependency).
5. Run `pnpm install`, then `pnpm verify`. Fix any issues until green.
6. Create a changeset (`pnpm changeset`) for the new package.

Follow every rule in AGENTS.md — especially: no root dependencies, one repo-wide version per
dependency, and the `.ts` config preference. Do not push or open a PR unless asked.
