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
4. For any dependency the package needs, add it to the catalog in `pnpm-workspace.yaml`
   first (caret range, already older than the 3-day `minimumReleaseAge`), then reference it
   as `catalog:` in the package.
5. Run `pnpm install`, then `pnpm verify`. Fix any issues until green.
6. Create a changeset (`pnpm changeset`) for the new package.

Follow every rule in AGENTS.md — especially: no root dependencies, catalog-only versions,
and the `.ts` config preference. Do not push or open a PR unless asked.
