# @mawesome/dependency-audit

> Verify every reachable bare import in a package's **released** artifact is declared and resolvable.

Catches the bug class where a published package imports a module — at runtime or in its emitted `.d.ts` — that resolves only via the author's hoisted dev tree, so a consumer installing it from npm can't resolve it. The motivating case: an emitted declaration does `import('react')` but `@types/react` was never declared.

> **Scope:** both the **type (`.d.ts`)** and **runtime (JS)** surfaces, against a local directory, a `.tgz`, or **any published spec** (`name@version`/tag, `@scope/name`, or an `http(s)` tarball URL — fetched via npm's cache/auth). Resolution runs against the package's _declared_ dependency ranges (materialized fresh), never the author's ambient `node_modules`. The runtime pass discovers entry points from `exports` (both `import`/`require` profiles), legacy `main`/`module`, and `bin`, follows the JS import graph, and honors each dep's own `exports`/`main` per call form. Node builtins need no declaration at runtime; on the type surface they imply `@types/node`.
>
> **Deferred:** the `browser` resolution profile + `--condition`.
>
> **Known limitations** (correct results, narrower coverage): `typesVersions` is applied for the **current** TypeScript version only (not the per-consumer-version matrix); the type surface resolves a single ESM/NodeNext profile (no per-file require context or `bundler` mode); and self-reference / `#imports` specifiers are skipped.

## Install

```sh
pnpm add -D @mawesome/dependency-audit
```

## CLI

```sh
# Audit a built package directory or a packed tarball
dependency-audit ./packages/my-lib
dependency-audit ./my-lib-1.2.3.tgz

# Several at once; machine-readable output for CI
dependency-audit --json ./packages/a ./packages/b
```

Exit codes: `0` clean, `1` findings, `2` error.

```
@acme/widget@1.2.3  ./packages/widget
  ✗ types  react  [undeclared]  dist/index.d.ts
      → declare "@types/react" (or "react" if it ships its own types)

1 package, 1 finding.
```

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

## Security

The audit is **fully static**: tarballs are only _extracted_ and files only _parsed_ — no target or dependency code is ever executed (no install scripts run). Registry fetches verify integrity (the resolved tarball URL + SRI are reported). Extraction skips symlink/hardlink entries and blocks path traversal, runs in throwaway temp dirs, and is bounded by a decompression-bomb guard (`maxBytes` / `maxEntries`, overridable via `audit(target, { extractLimits })`). Resolution runs against the target's _declared_ ranges in a fresh tree, never the author's ambient `node_modules`. When pointing the tool at an untrusted `http(s)` tarball URL in a service context, treat it as you would any fetch-by-URL: the _compressed_ download size is not separately capped (registry artifacts are size-bounded by npm), and SSRF is the caller's responsibility.

## License

[MIT](../../LICENSE) © 2026 Manzoor Ahmad Wani
