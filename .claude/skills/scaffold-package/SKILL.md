---
name: scaffold-package
description: Scaffold a new @mawesome/* package in this monorepo from templates/package. Use when adding a new publishable package, or when the /add-package command runs.
---

# Scaffold a `@mawesome/*` package

Creates a new publishable package under `packages/<name>` from the canonical template,
wired into the monorepo's strict toolchain. Read [AGENTS.md](../../../AGENTS.md) first and
follow every hard rule.

## Inputs

- `<name>`: the package name segment (lowercase kebab-case). The full package name is
  `@mawesome/<name>`. If not provided, ask for it.

## Steps

1. **Pick the name.** Validate `<name>` is a legal npm name segment. Confirm
   `packages/<name>` does not already exist.
2. **Copy the template.** `cp -R templates/package packages/<name>`.
3. **Substitute placeholders.** Replace `PACKAGE_NAME` with `<name>` everywhere it appears:
   - `packages/<name>/package.json` (`name`, `description`)
   - `packages/<name>/README.md`
   - `packages/<name>/src/index.ts` (the example export/comment)
4. **Declare dependencies (catalog-first).** For each dependency the package needs:
   - add it to `catalog:` in `pnpm-workspace.yaml` (a caret range, already older than the
     3-day `minimumReleaseAge`),
   - reference it as `"<dep>": "catalog:"` in the package's `dependencies`/`devDependencies`.
   - Internal `@mawesome/*` deps use `"workspace:*"`.
   - Never add anything to the root `package.json`.
5. **Install + verify.** `pnpm install`, then `pnpm verify`. Resolve failures:
   - formatting → `pnpm format`
   - dependency mismatches → `pnpm deps:fix`
   - lint → `pnpm lint:fix`
   - type errors → fix the source (the template uses `isolatedDeclarations`, so exported
     symbols need explicit types).
6. **Changeset.** Run `pnpm changeset`, select the new package, choose the initial bump, and
   write a summary.
7. **Stop.** Do not push or open a PR unless the user asks.

## What the template gives you

- Dual ESM/CJS build via tsdown with per-condition `.d.ts`/`.d.cts` exports.
- Strict TypeScript (extends `@mawesome/tsconfig`), type-checked with tsgo.
- A vitest test, and a `check:exports` gate (attw + publint) that validates the published
  surface across module resolution modes.
