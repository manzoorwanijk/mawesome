# Concepts

## The bug class

When you publish a package, the artifact consumers install is **not** your source tree — it is the built `dist/` (or `build/`) plus your `package.json`. Inside that artifact, two kinds of files reference other packages by **bare specifier** (`react`, `lodash/fp`, `node:fs`):

- emitted **type declarations** (`.d.ts`) — e.g. `export type Props = import('react').ComponentProps<'div'>`, or `/// <reference types="node" />`;
- emitted **runtime JS** — e.g. `import x from 'lodash'`, `require('debug')`, `createRequire(import.meta.url)('./native.node')`.

On the author's machine, those specifiers resolve because the dependency happens to be installed — hoisted into a shared `node_modules`, or present as a transitive dependency, or available as a dev dependency. But a **consumer** installing only your published package gets only the dependencies **your manifest declares**. If a reachable import is not declared (or is declared but ships no types, or points at a subpath the dependency does not export), the consumer's build breaks — with an error that points into _your_ package, not theirs.

The canonical case: an emitted declaration does `import('react')`, but `@types/react` was never declared. Your build is fine (you have React installed); your consumer's `tsc` fails to resolve the type. `dependency-audit` catches this class statically, before you publish.

This is not hypothetical: the tool grew out of exactly this problem recurring across [Gutenberg](https://github.com/WordPress/gutenberg)'s 100+ published packages, where missing `@types/react` / `csstype` and other declarations resolved only via root hoisting and broke for npm consumers ([#74655](https://github.com/WordPress/gutenberg/pull/74655), [#74310](https://github.com/WordPress/gutenberg/pull/74310), [#78882](https://github.com/WordPress/gutenberg/pull/78882)). See [Why this exists](../README.md#why-this-exists) for the full story.

## What it checks

For a target package, the tool verifies the invariant:

> **Every external bare specifier reachable in the released artifact resolves through a dependency the manifest declares.**

It checks this independently on two **surfaces**:

- **Type surface** (`.d.ts`) — resolved the way a consumer's TypeScript would, so `react` correctly falls back to `@types/react`.
- **Runtime surface** (JS) — resolved the way Node would at run time, honoring `exports`/`main` and the call form (`import` vs `require`).

A specifier that fails the invariant becomes a [finding](./findings.md). A surface that has _nothing to check_ (e.g. a package whose types were never built) becomes a [notice](./findings.md#notices), so "clean" is never confused with "nothing audited".

## The two surfaces

### Type surface

Entry points are discovered from the manifest, in priority order:

1. If `exports` is present, it **encapsulates** the package: only the type targets selected by the active conditions (`types` first, then the ESM profile) are entry points. Legacy `types`/`typings` and `typesVersions` are ignored when `exports` is present (TypeScript does `.js`→`.d.ts` extension substitution from the JS target).
2. If there is no `exports` but a `typesVersions` `"*"` catch-all, its mapped targets are the surface.
3. Otherwise, every `.d.ts` in the tarball is deep-importable, so the surface is all of them, plus `types`/`typings`/`module`/`main` substitution and any `typesVersions` targets.

From each entry, the tool follows **relative** imports across `.d.ts` files (the intra-package graph) and records every **external** specifier — including `import('x')` type-only imports, `/// <reference types="x" />` directives, and `declare module "x"` augmentations of real (non-pattern) module names.

### Runtime surface

Entry points are discovered from the manifest:

1. `exports` runtime targets for **both** the `import` and `require` profiles (a dual package can expose different specifiers under each).
2. Legacy `main` and `module`.
3. `bin` scripts — always executable regardless of `exports` encapsulation, including extensionless files with a `#!/usr/bin/env node` shebang.

From each entry, the tool follows the **relative** JS import graph and records every external specifier, **tagged by call form** (`import` or `require`), so each is resolved under the right condition set. It understands static `import`/`export … from`, `import x = require(...)`, dynamic `import('x')` (literal only), `require('x')`, `require.resolve('x')`, `createRequire(...)('x')`, and `createRequire(...).resolve('x')`. Non-literal/dynamic specifiers are surfaced as **unchecked**, never silently dropped.

## The resolution model

The point of the tool is to resolve against the package's **declared** dependencies, never the author's ambient `node_modules`. So before resolving, it **materializes** every declared dependency (production + peer + optional; never dev) at its declared range into one fresh, throwaway tree:

- **registry ranges** are fetched from npm (reusing npm's cache/auth) and extracted;
- **monorepo-local deps** — `file:../sibling`, `link:../sibling`, or `workspace:*` resolved by name through `pnpm-workspace.yaml` / `package.json#workspaces` — are **linked** to the already-built local sibling (no rebuild, fully static).

Then each specifier is resolved against that tree:

- **type** specifiers go through the bundled `typescript` (`ts.resolveModuleName` / `ts.resolveTypeReferenceDirective`) under NodeNext, so `@types/*` fallback works exactly as a consumer's checker would;
- **runtime** specifiers go through the dependency's own `exports`/`main` for the matching call form, with extension/index probing for `require`.

Node builtins (`node:fs`, `fs`, …) need no declaration at run time; on the type surface they imply `@types/node`.

See [Resolution model](./resolution.md) for the condition sets, profiles, and local-protocol details, and [Security](../README.md#security) for the guarantees around extraction and execution.
