# @mawesome/dependency-audit

> Verify every reachable bare import in a package's **released** artifact is declared and resolvable.

Catches the bug class where a published package imports a module — at runtime or, in
v1, in its emitted `.d.ts` — that resolves only via the author's hoisted dev tree, so a
consumer installing it from npm can't resolve it. The motivating case: an emitted
declaration does `import('react')` but `@types/react` was never declared.

> **Scope (v1):** the **type (`.d.ts`) surface** only. Resolution runs against the
> package's _declared_ dependency ranges (materialized fresh), never the author's ambient
> `node_modules`. The runtime-JS surface, published-spec targets, the full resolution
> matrix, and config-driven ignores are planned follow-ups.
>
> **Known v1 limitations** (correct results, narrower coverage): entry discovery does not
> apply `typesVersions` remapping or expand `exports` subpath _patterns_ (`"./*"`); it
> resolves a single ESM/NodeNext type profile (no per-file require context or `bundler`
> mode); and self-reference / `#imports` specifiers are skipped.

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
2. **Discover the type surface** from the _manifest_ (`exports` `types` conditions,
   legacy `types`/`typings`, `.js`→`.d.ts` substitution), then follow relative imports
   across `.d.ts` files. No hardcoded `build/` directory names.
3. **Materialize declared deps** (production + peer + optional, never dev) at their
   declared ranges into a fresh tree.
4. **Resolve** each external specifier with the bundled `typescript`. A specifier that
   doesn't resolve to a declaration is a finding — `undeclared` (nothing provides it) or
   `missing-types` (declared, but ships no resolvable declarations). Node builtins imply
   a requirement for `@types/node`.

## License

[MIT](../../LICENSE) © 2026 Manzoor Ahmad Wani
