import { builtinModules } from 'node:module';

/** Exact builtin specifiers, including real slash subpaths like `fs/promises`. */
const BUILTINS = new Set<string>(builtinModules);

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
		// non-builtin like `node:events/foo` is not waved through as a real builtin.
		const stripped = specifier.slice('node:'.length);
		return { packageName: bareName(stripped), isBuiltin: BUILTINS.has(stripped) };
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
