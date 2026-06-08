# @mawesome/dependency-audit

> Verify every reachable bare import in a package's **released** artifact is declared and resolvable.

**Try it live in your browser** — audit any published npm package, nothing installed: **[the dependency-audit playground](https://mawesome.pages.dev/dependency-audit/playground/)**.

Catches the bug class where a published package imports a module — at runtime or in its emitted `.d.ts` — that resolves at the author's build (via root hoisting, a `devDependency`, or a workspace link) but isn't declared as a consumer-visible dependency, so a consumer installing it from npm can't resolve it. The motivating case: an emitted declaration does `import('react')` but `@types/react` was never declared in `dependencies` or `peerDependencies` (or it was declared only in `devDependencies`).

It audits both the **type (`.d.ts`)** and **runtime (JS)** surfaces, against a local directory, a `.tgz`, or any published spec, resolving against the package's _declared_ dependency ranges (materialized fresh) — never the author's ambient `node_modules`.

📚 **Full documentation** is on the [docs site](https://mawesome.pages.dev/dependency-audit/) — [concepts](https://mawesome.pages.dev/dependency-audit/concepts/), the [CLI](https://mawesome.pages.dev/dependency-audit/cli/) and [API](https://mawesome.pages.dev/dependency-audit/api/) references, the [output format](https://mawesome.pages.dev/dependency-audit/output-format/) (text grammar + `--json` schema), a [findings & notices](https://mawesome.pages.dev/dependency-audit/findings/) reference, the [resolution model](https://mawesome.pages.dev/dependency-audit/resolution/), [limitations & troubleshooting](https://mawesome.pages.dev/dependency-audit/limitations/), [security](https://mawesome.pages.dev/dependency-audit/security/), and how it [compares to publint/attw](https://mawesome.pages.dev/dependency-audit/comparison/) — or read the source in [`docs/`](./docs/).

## Install

```sh
pnpm add -D @mawesome/dependency-audit
```

Or run it without installing — handy for a one-off audit of a published package:

```sh
npx @mawesome/dependency-audit lodash@4.17.21
```

## CLI

```sh
# Audit a built package directory or a packed tarball
dependency-audit ./packages/my-lib
dependency-audit ./my-lib-1.2.3.tgz

# Audit a package straight from npm — by version, tag, or scope
dependency-audit lodash@4.17.21
dependency-audit @sindresorhus/is@latest

# Several at once; machine-readable output for CI
dependency-audit --json ./packages/a ./packages/b
```

Exit codes: `0` clean, `1` findings, `2` error. See the [CLI reference](./docs/cli.md) for every flag (including `--condition`, `--require-types`, and config files).

```
@acme/widget@1.2.3  ./packages/widget
  ✗ types      [undeclared]     react  (dist/index.d.ts)
      → declare "@types/react" (or "react" if it ships its own types)

1 package, 1 finding.
```

### Ignoring intentional findings

Findings that static analysis can't prove are fine (an optional/plugin import, a known false positive) can be suppressed via `--ignore <package-or-specifier>` or a JSON config — and through the programmatic API (`audit(target, { ignore: [{ package: 'x' }] })`). Suppressed findings are still listed and never fail the audit. See [findings & notices](./docs/findings.md#ignoring-intentional-findings) for the rule grammar, and [coverage notices](./docs/findings.md#notices) for `types-not-built` / `types-unreachable` and `--require-types`.

## Programmatic API

```ts
import { audit } from '@mawesome/dependency-audit';

const result = await audit('./packages/my-lib');
if (!result.ok) {
	for (const finding of result.findings) {
		console.error(`${finding.packageName}: ${finding.suggestion}`);
	}
}
```

The core is also filesystem-agnostic: `@mawesome/dependency-audit/browser` exports `auditPackage` over an injectable `FileSystem` (no `node:fs`, no `pacote`), so you can audit an in-memory tree in the browser. The dependency artifact provider is injectable too — supply your own `RegistryProvider` to resolve against an offline mirror, a local cache, or a CDN instead of the npm registry. See the [API reference](./docs/api.md) for `auditPackage`, the `FileSystem`/`RegistryProvider` ports, and the full options.

## Why this exists

This tool grew out of a recurring, hard-to-catch problem in [Gutenberg](https://github.com/WordPress/gutenberg) — a monorepo of 100+ published `@wordpress/*` packages that power the WordPress block editor. Package after package referenced a module in its **published** files — most often `import('react').ReactNode` in an emitted `build-types/*.d.ts` — without declaring it where a consumer could resolve it. It built fine in the repo, because the module was resolvable at the author's build _somehow_: hoisted into the root `node_modules` on classic npm, or present as a `devDependency`, or linked from a workspace sibling. A **consumer** installing the package from npm gets none of that — only the package's consumer-visible deps (`dependencies` / `peerDependencies` / `optionalDependencies`, never `devDependencies`) — so the reference broke. With `skipLibCheck: true` (a common setting) their TypeScript silently degraded the affected exports to `any`; without it, resolution failed outright.

These were fixed one batch at a time — [`csstype` in `@wordpress/components`](https://github.com/WordPress/gutenberg/pull/74655), [a sweep of missing package deps](https://github.com/WordPress/gutenberg/pull/74310), and [`@types/react` across many packages](https://github.com/WordPress/gutenberg/pull/78882) — but [the question raised in review](https://github.com/WordPress/gutenberg/pull/78882#issuecomment-4609049977) was the real problem:

> Can we enforce this somehow…? As far as I understand, we have no protections against regressions, and new dependencies will be easy to miss in the same way we missed these until now. … How do we expect someone to choose between `devDependencies` and `dependencies`?

This isn't really a hoisted-vs-isolated problem. Moving to an isolated layout (pnpm, or npm [`install-strategy=linked`](https://docs.npmjs.com/cli/v11/commands/npm-install#install-strategy)) surfaces the _fully-undeclared_ phantom deps, but it can't see the larger share of these: a dependency declared in the **wrong place**. `@types/react` in `devDependencies` resolves perfectly at the author's isolated build, yet still leaks into the published `.d.ts` and breaks consumers — and whether it belongs in `dependencies` or `devDependencies` hinges on whether it appears in the **emitted** surface, which neither an isolated install nor a source-level linter (ESLint / `eslint-plugin-import` only see _source_) can determine. The reply in [that thread](https://github.com/WordPress/gutenberg/pull/78882#issuecomment-4609049977) — _"I am exploring the options to fix this via some tool"_ — is what became `dependency-audit`: it materializes only the consumer-visible declared deps (production + peer + optional, never dev) and resolves the **released** surface (both `.d.ts` and runtime JS) against them, flagging anything undeclared or unresolvable — so this class of bug fails CI before it ships, regardless of how anyone's `node_modules` is laid out.

## Complementary tools

`dependency-audit` answers one focused question — _does the released artifact declare and resolve every package it imports?_ It pairs naturally with [**publint**](https://publint.dev) (is the manifest well-formed?) and [**attw**](https://github.com/arethetypeswrong/arethetypeswrong.github.io) (do your own types resolve across module modes?); run all three before you publish. See the [comparison](./docs/comparison.md) for how they differ and why they barely overlap.

## License

[MIT](../../LICENSE)
