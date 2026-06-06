# @mawesome/dependency-audit

> Verify every reachable bare import in a package's **released** artifact is declared and resolvable.

**Try it live in your browser** — audit any published npm package, nothing installed: **[the dependency-audit playground](https://mawesome.pages.dev/dependency-audit/playground/)**.

Catches the bug class where a published package imports a module — at runtime or in its emitted `.d.ts` — that resolves at the author's build (via root hoisting, a `devDependency`, or a workspace link) but isn't declared as a consumer-visible dependency, so a consumer installing it from npm can't resolve it. The motivating case: an emitted declaration does `import('react')` but `@types/react` was never declared in `dependencies` or `peerDependencies` (or it was declared only in `devDependencies`).

> **Scope:** both the **type (`.d.ts`)** and **runtime (JS)** surfaces, against a local directory, a `.tgz`, or **any published spec** (`name@version`/tag, `@scope/name`, or an `http(s)` tarball URL — fetched via npm's cache/auth). Resolution runs against the package's _declared_ dependency ranges (materialized fresh), never the author's ambient `node_modules`. The runtime pass discovers entry points from `exports` (both `import`/`require` profiles), legacy `main`/`module`, and `bin`, follows the JS import graph, and honors each dep's own `exports`/`main` per call form. Node builtins need no declaration at runtime; on the type surface they imply `@types/node`.
>
> **Known limitations** (correct results, narrower coverage): `typesVersions` is applied for the **current** TypeScript version only (not the per-consumer-version matrix); the type surface resolves a single ESM/NodeNext profile (no per-file require context or `bundler` mode); the legacy `browser` **field** remap (`{ "browser": { "./a": "./b" } }`) is not applied — only the `browser` **export condition** is honored via `--condition browser`; and self-reference / `#imports` specifiers are skipped.

📚 **Full documentation** lives in [`docs/`](./docs/) — [concepts](./docs/concepts.md), the [CLI](./docs/cli.md) and [API](./docs/api.md) references, the [output format](./docs/output-format.md) (text grammar + `--json` schema), a [findings & notices](./docs/findings.md) reference, the [resolution model](./docs/resolution.md), [limitations & troubleshooting](./docs/limitations.md), and how it [compares to publint/attw](./docs/comparison.md).

## Install

```sh
pnpm add -D @mawesome/dependency-audit
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

# Audit the `browser` export condition instead of the default Node profile
dependency-audit --condition browser ./packages/my-lib
```

`--condition <name>` (repeatable) activates an extra `exports` condition on top of the Node defaults, for both entry discovery and resolution — e.g. `--condition browser` audits the surface a bundler sees under the `browser` condition.

Exit codes: `0` clean, `1` findings, `2` error.

```
@acme/widget@1.2.3  ./packages/widget
  ✗ types      [undeclared]     react  (dist/index.d.ts)
      → declare "@types/react" (or "react" if it ships its own types)

1 package, 1 finding.
```

Output is colorized by severity on a terminal (red findings, yellow notices, green clean) and auto-plain when piped or under `--json`; `NO_COLOR` / `FORCE_COLOR` are respected.

While auditing, a live progress line (current phase, deps materialized) is drawn on **stderr** so a long run never looks hung. It renders only when stderr is an interactive terminal, so results on stdout — including `--json` and redirects like `dependency-audit . > result.json` — are never polluted. Pass `--no-progress` (or set `NO_PROGRESS`) to suppress it even on a terminal.

### Ignoring intentional findings

Suppress findings static analysis can't prove are fine (an optional/plugin import, a known false positive). Suppressed findings are still listed (`– ignored`) and echoed in `--json`, so suppressions stay auditable; they do not fail the audit.

```sh
# --ignore <value> matches a finding by package OR exact specifier (repeatable)
dependency-audit --ignore optional-plugin --ignore react/jsx-runtime ./packages/my-lib
```

Or a JSON config (`./dependency-audit.config.json` by default, or `--config <path>`). A rule matches a finding when every field it sets equals the finding's; an empty rule matches nothing:

```json
{
	"ignore": [
		{ "package": "optional-plugin" },
		{ "specifier": "react/jsx-runtime", "surface": "types" },
		{ "surface": "runtime", "kind": "unresolved" }
	]
}
```

The programmatic API takes the same rules: `audit(target, { ignore: [{ package: 'x' }] })`.

### Coverage notices

So "audited, clean" is never confused with "nothing to audit," the tool emits a per-target **notice** (not a finding — it does not fail the audit) when a package has no analyzable type surface: `types-not-built` (the manifest declares types but none resolve — build the package first) or `types-unreachable` (it ships `.d.ts` files but no `types` field / `exports` `types` condition exposes them — a likely packaging gap). Notices appear in the text output (`ℹ`) and in each result's `notices` array under `--json`. Pass `--require-types` to treat such a notice as a failure (exit 1).

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

### Browser / custom filesystem

The core is filesystem-agnostic. `@mawesome/dependency-audit/browser` exports `auditPackage` over an injectable [`FileSystem`](src/fs.ts) — no `node:fs`/`os`/`module`, no `pacote` (the only `node:` import is `node:path`, which bundlers alias to `path-browserify`). Seed an in-memory tree and supply a provider that materializes deps into it:

```ts
import { auditPackage, createMemoryFileSystem } from '@mawesome/dependency-audit/browser';

const fs = createMemoryFileSystem();
fs.writeFile('/pkg/package.json' /* … */);
// … write the package's .d.ts / .js files …

const result = await auditPackage(fs, '/pkg', {
	provider: {
		async materialize(name, range, intoDir) {
			/* fetch from a CDN into fs */
		},
	},
	workDir: '/work',
});
```

The Node `audit(target)` is just this core wrapped with `.tgz`/directory acquisition and a temp dir. A browser host supplies its own acquisition (fetch + untar) and a CDN-backed provider (jsDelivr/unpkg).

### Injectable provider (Node)

The dependency artifact provider is injectable — supply your own to resolve against a local cache or an offline mirror instead of the npm registry:

```ts
import { audit, type RegistryProvider } from '@mawesome/dependency-audit';

const provider: RegistryProvider = {
	async materialize(name, range, intoDir) {
		/* extract name@range into `${intoDir}/node_modules/${name}`; return the version */
		return '18.3.1';
	},
};
await audit('./packages/my-lib', { provider });
```

## How it works

1. **Acquire** — a directory is read in place; a `.tgz` is extracted to a temp dir.
2. **Discover both surfaces** from the _manifest_ (never hardcoded `build/` names):
   - _Type_ — `exports` `types` conditions, legacy `types`/`typings`, `.js`→`.d.ts` substitution; then follow relative imports across `.d.ts` files.
   - _Runtime_ — `exports` runtime targets (`import` + `require` profiles), legacy `main`/`module`, and `bin`; then follow the relative JS import graph, tagging each specifier with its call form.
3. **Materialize declared deps** (production + peer + optional, never dev) at their declared ranges into one fresh tree, shared by both passes. Registry ranges are fetched from npm; **monorepo-local deps** (`file:../sibling`, or `workspace:*` resolved by name through `pnpm-workspace.yaml` / `package.json#workspaces`) link the local already-built sibling — no rebuild, fully static.
4. **Resolve** each external specifier. Type specifiers go through the bundled `typescript` (so `react` falls back to `@types/react`); runtime specifiers go through the dep's own `exports`/`main` for the matching call form. A specifier that doesn't resolve is a finding — `undeclared` (nothing provides it), `missing-types` (declared, ships no declarations), or `unresolved` (declared, but the runtime subpath/file is not reachable). Node builtins need no declaration at runtime; on the type surface they imply `@types/node`.

## Why this exists

This tool grew out of a recurring, hard-to-catch problem in [Gutenberg](https://github.com/WordPress/gutenberg) — a monorepo of 100+ published `@wordpress/*` packages that power the WordPress block editor. Package after package referenced a module in its **published** files — most often `import('react').ReactNode` in an emitted `build-types/*.d.ts` — without declaring it where a consumer could resolve it. It built fine in the repo, because the module was resolvable at the author's build _somehow_: hoisted into the root `node_modules` on classic npm, or present as a `devDependency`, or linked from a workspace sibling. A **consumer** installing the package from npm gets none of that — only the package's consumer-visible deps (`dependencies` / `peerDependencies` / `optionalDependencies`, never `devDependencies`) — so the reference broke. With `skipLibCheck: true` (a common setting) their TypeScript silently degraded the affected exports to `any`; without it, resolution failed outright.

These were fixed one batch at a time — [`csstype` in `@wordpress/components`](https://github.com/WordPress/gutenberg/pull/74655), [a sweep of missing package deps](https://github.com/WordPress/gutenberg/pull/74310), and [`@types/react` across many packages](https://github.com/WordPress/gutenberg/pull/78882) — but [the question raised in review](https://github.com/WordPress/gutenberg/pull/78882#issuecomment-4609049977) was the real problem:

> Can we enforce this somehow…? As far as I understand, we have no protections against regressions, and new dependencies will be easy to miss in the same way we missed these until now. … How do we expect someone to choose between `devDependencies` and `dependencies`?

This isn't really a hoisted-vs-isolated problem. Moving to an isolated layout (pnpm, or npm [`install-strategy=linked`](https://docs.npmjs.com/cli/v11/commands/npm-install#install-strategy)) surfaces the _fully-undeclared_ phantom deps, but it can't see the larger share of these: a dependency declared in the **wrong place**. `@types/react` in `devDependencies` resolves perfectly at the author's isolated build, yet still leaks into the published `.d.ts` and breaks consumers — and whether it belongs in `dependencies` or `devDependencies` hinges on whether it appears in the **emitted** surface, which neither an isolated install nor a source-level linter (ESLint / `eslint-plugin-import` only see _source_) can determine. The reply in [that thread](https://github.com/WordPress/gutenberg/pull/78882#issuecomment-4609049977) — _"I am exploring the options to fix this via some tool"_ — is what became `dependency-audit`: it materializes only the consumer-visible declared deps (production + peer + optional, never dev) and resolves the **released** surface (both `.d.ts` and runtime JS) against them, flagging anything undeclared or unresolvable — so this class of bug fails CI before it ships, regardless of how anyone's `node_modules` is laid out.

## Complementary tools

`dependency-audit` answers one focused question — _does the released artifact declare and resolve every package it imports?_ It pairs naturally with two excellent, narrowly-scoped publishing checks; run all three before you publish:

| Tool                                                                                                 | Asks                                                                                              | Catches                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**publint**](https://publint.dev)                                                                   | Is the **manifest** well-formed for publishing?                                                   | bad `exports`/`main`/`types` paths, missing files, wrong file extensions, `module` field mistakes                                                                            |
| [**attw**](https://github.com/arethetypeswrong/arethetypeswrong.github.io) (`@arethetypeswrong/cli`) | Do **your own types** resolve correctly across module-resolution modes (node16 CJS/ESM, bundler)? | `.d.ts` that resolve under ESM but not CJS, masquerading CJS/ESM, missing type entry points                                                                                  |
| **dependency-audit**                                                                                 | Do the imports in the released artifact resolve through **declared dependencies**?                | a `.d.ts` that does `import('react')` with no `@types/react` declared; a runtime `require('x')` of an undeclared package; a deep import of a subpath the dep does not export |

They barely overlap. publint validates the _shape_ of your package; attw validates that _your_ types are consumable; dependency-audit validates that the _dependencies your code reaches_ are all declared and installable. A package can pass publint and attw and still ship a `.d.ts` importing an undeclared transitive — which is exactly the gap this tool closes. If you only adopt one of the three, still try the others — they're quick and they each catch a different class of "works on my machine" bug. (This repo runs publint + attw on itself via `pnpm check:exports`.)

## Security

The audit is **fully static**: tarballs are only _extracted_ and files only _parsed_ — no target or dependency code is ever executed (no install scripts run). Registry fetches verify integrity (the resolved tarball URL + SRI are reported). Extraction skips symlink/hardlink entries and blocks path traversal, runs in throwaway temp dirs, and is bounded by a decompression-bomb guard (`maxBytes` / `maxEntries`, overridable via `audit(target, { extractLimits })`). Resolution runs against the target's _declared_ ranges in a fresh tree, never the author's ambient `node_modules`. When pointing the tool at an untrusted `http(s)` tarball URL in a service context, treat it as you would any fetch-by-URL: the _compressed_ download size is not separately capped (registry artifacts are size-bounded by npm), and SSRF is the caller's responsibility.

## License

[MIT](../../LICENSE) © 2026 Manzoor Ahmad Wani
