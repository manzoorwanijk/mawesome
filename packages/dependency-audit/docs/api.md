# Programmatic & browser API

Two entry points:

- `@mawesome/dependency-audit` — the **Node** API. `audit(target)` acquires a directory/`.tgz`/spec and runs over the real filesystem.
- `@mawesome/dependency-audit/browser` — the **runtime-agnostic core**. `auditPackage(fs, root, options)` runs over any injected [`FileSystem`](#filesystem), with no `node:fs`/`os`/`module` and no `pacote`. The only `node:` import is `node:path` (bundlers alias it to `path-browserify`).

All types referenced below are exported from both entry points.

## `audit(target, options?)`

```ts
import { audit } from '@mawesome/dependency-audit';

const result = await audit('./packages/my-lib');
if (!result.ok) {
	for (const finding of result.findings) {
		console.error(`${finding.packageName}: ${finding.suggestion}`);
	}
}
```

```ts
function audit(target: string, options?: AuditOptions): Promise<AuditResult>;

interface AuditOptions {
	/** Override the dependency artifact provider (tests/offline mirrors inject a hermetic one). */
	provider?: RegistryProvider;
	/** Rules that suppress intentional findings. */
	ignore?: IgnoreRule[];
	/** Override the tarball extraction caps (decompression-bomb guard). */
	extractLimits?: ExtractLimits;
	/** Extra resolution conditions to activate (e.g. ["browser"]), added to the defaults. */
	conditions?: readonly string[];
}
```

`target` is a directory, a `.tgz` path, a published spec, or an `http(s)` tarball URL — the same set the [CLI](./cli.md) accepts. The returned [`AuditResult`](./output-format.md#auditresult) is exactly the per-target JSON object.

## `auditPackage(fs, root, options)`

The filesystem-agnostic core. Use it to audit an in-memory tree (browser, tests, a custom VFS):

```ts
import { auditPackage, createMemoryFileSystem } from '@mawesome/dependency-audit/browser';

const fs = createMemoryFileSystem();
fs.writeFile('/pkg/package.json', JSON.stringify({ name: 'demo', types: './index.d.ts' }));
fs.writeFile('/pkg/index.d.ts', "export type X = import('react').FC;");

const result = await auditPackage(fs, '/pkg', {
	workDir: '/work',
	provider: {
		async materialize(name, range, intoDir) {
			/* fetch name@range from a CDN and write it into `${intoDir}/node_modules/${name}` on `fs`; return the version */
			return undefined;
		},
	},
});
```

```ts
function auditPackage(
	fs: FileSystem,
	root: string,
	options: AuditPackageOptions,
): Promise<AuditResult>;

interface AuditPackageOptions {
	/** Materializes declared deps into `workDir/node_modules` on `fs`. */
	provider: RegistryProvider;
	/** Where the provider materializes deps (a real temp dir on Node; any path in memory). */
	workDir: string;
	/** Label for the result's `target` field. Defaults to `root`. */
	target?: string;
	/** How the package was acquired (recorded on the result). Defaults to `{ kind: 'directory' }`. */
	source?: AcquiredSource;
	/** Rules that suppress intentional findings. */
	ignore?: IgnoreRule[];
	/** Node builtin names. The Node entry injects the live `builtinModules`; the core defaults to a hardcoded list. */
	builtins?: readonly string[];
	/** Extra resolution conditions to activate, added to the defaults. */
	conditions?: readonly string[];
	/** Package-relative POSIX paths to restrict the scan to (the publish set). Absent = scan every file. The Node entry computes this for directory targets via `npm-packlist`. */
	includeFiles?: ReadonlySet<string>;
}
```

The Node `audit()` is just this core wrapped with acquisition (`.tgz`/directory/spec) and a temp `workDir`, supplying a [`createPacoteProvider`](#registryprovider) and the live `builtinModules`.

## `FileSystem`

The read port the core depends on. `createMemoryFileSystem()` returns a `WritableFileSystem` (the read port plus `writeFile(path, content)`, which seeds files for the audit). See [`src/fs.ts`](../src/fs.ts) for the exact interface; the read surface is roughly:

```ts
interface FileSystem {
	isFile(path: string): boolean;
	isDirectory(path: string): boolean;
	readFile(path: string): string;
	readdirRecursive(path: string): string[];
	realpath(path: string): string;
	// …
}
```

`nodeFileSystem` (exported from the Node entry) implements this over `node:fs`.

## `RegistryProvider`

The port that materializes a declared dependency so resolution runs against the target's **declared ranges**, never the author's ambient `node_modules`:

```ts
interface RegistryProvider {
	/** Extract name@(highest satisfying range) into `${intoDir}/node_modules/${name}`; return the resolved version (or undefined if it could not be materialized). */
	materialize(name: string, range: string, intoDir: string): Promise<string | undefined>;
	/** Optional: does `name` exist on the registry? Used only to refine `missing-types` into `types-unavailable`; return `'unknown'` when the lookup can't run. */
	packageExists?(name: string): Promise<'exists' | 'absent' | 'unknown'>;
}
```

- **Node default** — `createPacoteProvider({ where, limits })` (and the ready-made `pacoteProvider`): fetches registry ranges via pacote, links local `file:`/`link:`/`workspace:` deps, and implements `packageExists` (a `pacote.packument` probe; 404 → `absent`, any other failure → `unknown`). `where` is the directory local ranges resolve against (the audited package's own dir).
- **Inject your own** to resolve against an offline mirror, a local cache, or a CDN (browser). A provider that returns `undefined` for a name means "could not materialize" — references to it then surface as findings. Omitting `packageExists` simply disables the `types-unavailable` refinement.

## Exported types

`AuditOptions`, `AuditResult`, `AuditPackageOptions`, `Finding`, `FindingKind`, `UnresolvedReason`, `FindingCause`, `Notice`, `NoticeKind`, `Surface`, `UncheckedSpecifier`, `ResolvedDependency`, `AcquiredSource`, `IgnoreRule`, `ExtractLimits`, `RegistryProvider`, `FileSystem`, `WritableFileSystem`, plus `createMemoryFileSystem`, `nodeFileSystem`, `createPacoteProvider`, `pacoteProvider`, `DEFAULT_EXTRACT_LIMITS`, `ExtractLimitError`. See [`src/types.ts`](../src/types.ts) for the authoritative definitions.
