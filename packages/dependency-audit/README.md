# @mawesome/dependency-audit

> Verify every reachable bare import in a package's **released** artifact is declared and resolvable.

Catches the bug class where a published package imports a module — at runtime or in its
emitted `.d.ts` — that resolves only via the author's hoisted dev tree, so a consumer
installing it from npm can't resolve it. The motivating case: an emitted declaration does
`import('react')` but `@types/react` was never declared.

> **Scope:** both the **type (`.d.ts`)** and **runtime (JS)** surfaces. Resolution runs
> against the package's _declared_ dependency ranges (materialized fresh), never the
> author's ambient `node_modules`. The runtime pass discovers entry points from `exports`
> (both `import`/`require` profiles), legacy `main`/`module`, and `bin`, follows the JS
> import graph, and honors each dep's own `exports`/`main` per call form. Node builtins
> need no declaration at runtime; on the type surface they imply `@types/node`.
>
> **Deferred:** published-spec targets (`name@version`), install lifecycle scripts, the
> `browser` profile, `require.resolve`/`createRequire`/import-attribute call forms, and
> config-driven ignores.
>
> **Known limitations** (correct results, narrower coverage): entry discovery does not
> apply `typesVersions` remapping or expand `exports` subpath _patterns_ (`"./*"`); the
> type surface resolves a single ESM/NodeNext profile (no per-file require context or
> `bundler` mode); and self-reference / `#imports` specifiers are skipped.

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

The dependency artifact provider is injectable — supply your own to resolve against a
local cache or an offline mirror instead of the npm registry:

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
   - _Type_ — `exports` `types` conditions, legacy `types`/`typings`, `.js`→`.d.ts`
     substitution; then follow relative imports across `.d.ts` files.
   - _Runtime_ — `exports` runtime targets (`import` + `require` profiles), legacy
     `main`/`module`, and `bin`; then follow the relative JS import graph, tagging each
     specifier with its call form.
3. **Materialize declared deps** (production + peer + optional, never dev) at their
   declared ranges into one fresh tree, shared by both passes.
4. **Resolve** each external specifier. Type specifiers go through the bundled
   `typescript` (so `react` falls back to `@types/react`); runtime specifiers go through
   the dep's own `exports`/`main` for the matching call form. A specifier that doesn't
   resolve is a finding — `undeclared` (nothing provides it), `missing-types` (declared,
   ships no declarations), or `unresolved` (declared, but the runtime subpath/file is not
   reachable). Node builtins need no declaration at runtime; on the type surface they
   imply `@types/node`.

## License

[MIT](../../LICENSE) © 2026 Manzoor Ahmad Wani
