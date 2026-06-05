/*
 * Node builtin module specifiers (including real slash subpaths). Hardcoded rather than
 * read from `node:module` so the core stays browser-safe. A `node:` prefix is normalized
 * before lookup; this list is the unprefixed form.
 */
const NODE_BUILTINS = [
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

/** Exact bare builtin specifiers, including real slash subpaths like `fs/promises`. */
const BUILTINS = new Set<string>(NODE_BUILTINS);

/** A specifier classified into its owning package. */
export interface NormalizedSpecifier {
	/** The owning package name (`@scope/x/sub` → `@scope/x`, `react/jsx-runtime` → `react`). */
	packageName: string;
	/** A Node builtin (`fs`, `node:path`, `fs/promises`). On the type surface these
	 *  imply a requirement for `@types/node`. */
	isBuiltin: boolean;
}

/**
 * Classifies a bare import specifier into its owning package, or returns `null`
 * for specifiers that are not package imports (relative/absolute paths, URLs).
 */
export function normalizeSpecifier(specifier: string): NormalizedSpecifier | null {
	if (specifier.startsWith('node:')) {
		// The `node:` scheme is the builtin namespace; classify by exact membership so a
		// non-builtin like `node:events/foo` is not waved through as a real builtin. Both
		// regular and prefix-only builtins are valid under the `node:` scheme.
		const stripped = specifier.slice('node:'.length);
		const isBuiltin = BUILTINS.has(stripped) || NODE_PREFIX_ONLY.has(stripped);
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
		// are not external package imports for v1 (self/#imports resolution is deferred).
		return null;
	}

	// Builtins match the exact specifier (so `fs/promises` is builtin, `events/foo` is not).
	return { packageName: bareName(specifier), isBuiltin: BUILTINS.has(specifier) };
}

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
