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

It grew out of a recurring, hard-to-catch problem in [Gutenberg](https://github.com/WordPress/gutenberg) — 100+ published `@wordpress/*` packages where a module referenced in the **published** files (most often `import('react')` in an emitted `.d.ts`) resolved at the author's build via hoisting, a `devDependency`, or a workspace link, but wasn't declared where a consumer could resolve it. The deeper issue isn't hoisted-vs-isolated: it's a dependency in the **wrong place** — a `devDependency` whose types leak into the published `.d.ts` — which neither an isolated install nor a source-level linter can catch. [Read the full story](https://mawesome.pages.dev/dependency-audit/why/).

## Complementary tools

`dependency-audit` answers one focused question — _does the released artifact declare and resolve every package it imports?_ It pairs naturally with [**publint**](https://publint.dev) (is the manifest well-formed?) and [**attw**](https://github.com/arethetypeswrong/arethetypeswrong.github.io) (do your own types resolve across module modes?); run all three before you publish. See the [comparison](./docs/comparison.md) for how they differ and why they barely overlap.

## License

[MIT](../../LICENSE)
