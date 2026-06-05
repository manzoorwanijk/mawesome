/*
 * Default Node builtin module specifiers (including real slash subpaths). The core is
 * browser-safe and can't read `node:module`, so this hardcoded list is the fallback; the
 * Node entry injects the live `builtinModules` via `createNormalizer` to avoid drift.
 * Specifiers are the unprefixed form; a `node:` prefix is normalized before lookup.
 */
export const DEFAULT_NODE_BUILTINS: readonly string[] = [
	'assert',
	'assert/strict',
	'async_hooks',
	'buffer',
	'child_process',
	'cluster',
	'console',
	'constants',
	'crypto',
	'dgram',
	'diagnostics_channel',
	'dns',
	'dns/promises',
	'domain',
	'events',
	'fs',
	'fs/promises',
	'http',
	'http2',
	'https',
	'inspector',
	'inspector/promises',
	'module',
	'net',
	'os',
	'path',
	'path/posix',
	'path/win32',
	'perf_hooks',
	'process',
	'punycode',
	'querystring',
	'readline',
	'readline/promises',
	'repl',
	'stream',
	'stream/consumers',
	'stream/promises',
	'stream/web',
	'string_decoder',
	'sys',
	'timers',
	'timers/promises',
	'tls',
	'trace_events',
	'tty',
	'url',
	'util',
	'util/types',
	'v8',
	'vm',
	'wasi',
	'worker_threads',
	'zlib',
];

/*
 * Builtins reachable ONLY via the `node:` prefix — a *bare* `import 'test'` resolves to an
 * npm package, not the builtin, so these are excluded from the bare set and matched only
 * after a `node:` prefix.
 */
const NODE_PREFIX_ONLY = new Set<string>(['sea', 'sqlite', 'test', 'test/reporters']);

/** A specifier classified into its owning package. */
export interface NormalizedSpecifier {
	/** The owning package name (`@scope/x/sub` → `@scope/x`, `react/jsx-runtime` → `react`). */
	packageName: string;
	/** A Node builtin (`fs`, `node:path`, `fs/promises`). On the type surface these
	 *  imply a requirement for `@types/node`. */
	isBuiltin: boolean;
}

/** Classifies a specifier into its owning package, or `null` for non-package imports. */
export type Normalizer = (specifier: string) => NormalizedSpecifier | null;

/**
 * Builds a {@link Normalizer} over a Node builtins set (default {@link DEFAULT_NODE_BUILTINS};
 * the Node entry passes the live `builtinModules`). Prefix-only builtins (`test`/`sqlite`/
 * `sea`) are matched only under the `node:` scheme regardless of the injected set, so a bare
 * `import 'test'` is always audited as an npm package.
 */
export function createNormalizer(builtins: Iterable<string> = DEFAULT_NODE_BUILTINS): Normalizer {
	const set = new Set(builtins);
	return (specifier) => {
		if (specifier.startsWith('node:')) {
			// The `node:` scheme is the builtin namespace; classify by exact membership so a
			// non-builtin like `node:events/foo` is not waved through as a real builtin.
			const stripped = specifier.slice('node:'.length);
			const isBuiltin = set.has(stripped) || NODE_PREFIX_ONLY.has(stripped);
			return { packageName: bareName(stripped), isBuiltin };
		}
		if (
			specifier === '' ||
			specifier.startsWith('.') ||
			specifier.startsWith('/') ||
			specifier.startsWith('#') ||
			/^[a-z][a-z0-9+.-]*:/i.test(specifier)
		) {
			// Relative/absolute paths, `#imports`, and URI-scheme specifiers (data:, http:, file:)
			// are not external package imports (self/#imports resolution is deferred).
			return null;
		}
		// Bare builtins match the exact specifier (so `fs/promises` is builtin, `events/foo`
		// is not), excluding prefix-only names which are only builtins under `node:`.
		const isBuiltin = set.has(specifier) && !NODE_PREFIX_ONLY.has(specifier);
		return { packageName: bareName(specifier), isBuiltin };
	};
}

/** The default normalizer, bound to {@link DEFAULT_NODE_BUILTINS} (browser-safe). */
export const normalizeSpecifier: Normalizer = createNormalizer();

/** Extracts the package name from a (possibly scoped, possibly subpath) specifier. */
function bareName(specifier: string): string {
	const parts = specifier.split('/');
	if (specifier.startsWith('@')) {
		return parts.slice(0, 2).join('/');
	}
	return parts[0] ?? specifier;
}

/** Maps a package name to the DefinitelyTyped package that would provide its types. */
export function typesPackageFor(packageName: string): string {
	if (packageName.startsWith('@')) {
		// `@scope/name` → `@types/scope__name`.
		return `@types/${packageName.slice(1).replace('/', '__')}`;
	}
	return `@types/${packageName}`;
}
