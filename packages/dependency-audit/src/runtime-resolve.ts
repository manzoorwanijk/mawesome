import { join } from 'node:path';
import { exports as resolveExports, legacy as resolveLegacyFields } from 'resolve.exports';
import type { FileSystem } from './fs.ts';
import type { CallForm } from './runtime-surface.ts';

/** Resolves runtime specifiers against the materialized declared-dependency tree. */
export interface RuntimeResolver {
	/** `true` if `specifier` resolves to a file in the declared dep for the call `form`. */
	resolvesRuntime(specifier: string, form: CallForm): boolean;
}

interface DepManifest {
	name?: string;
	main?: string;
	module?: string;
	exports?: unknown;
}

/**
 * Builds a runtime resolver over an already-materialized `<workDir>`. For each
 * declared dep it honors the package's own `exports` for the active condition set
 * (`import` vs `require`), falling back to legacy `main`/`module` + index probing.
 */
export function createRuntimeResolver(
	fs: FileSystem,
	workDir: string,
	conditions: readonly string[] = [],
): RuntimeResolver {
	const nodeModules = join(workDir, 'node_modules');
	const extraConditions = conditions.length > 0 ? [...conditions] : undefined;

	return {
		resolvesRuntime(specifier: string, form: CallForm): boolean {
			const { name, subpath } = splitSpecifier(specifier);
			const depDir = join(nodeModules, name);
			const manifestPath = join(depDir, 'package.json');
			if (!fs.isFile(manifestPath)) {
				return false;
			}
			const pkg = JSON.parse(fs.readFile(manifestPath)) as DepManifest;

			if (pkg.exports !== undefined) {
				/**
				 * `exports` encapsulates the package: only mapped subpaths resolve. An
				 * array target is a fallback list — the first that exists as a file wins.
				 * Resolve against the subpath entry (`.`/`./sub`), not the raw specifier:
				 * an `npm:` alias materializes under the alias key while its manifest keeps
				 * its real name, so `resolve.exports` would otherwise read the specifier as a
				 * missing subpath of that real name.
				 */
				const entry = subpath === '' ? '.' : `./${subpath}`;
				try {
					const targets = resolveExports(pkg, entry, {
						require: form === 'require',
						...(extraConditions !== undefined ? { conditions: extraConditions } : {}),
					});
					return Array.isArray(targets) && targets.some((t) => fs.isFile(join(depDir, t)));
				} catch {
					return false;
				}
			}
			return resolvesLegacy(fs, depDir, pkg, subpath, form);
		},
	};
}

/** Legacy resolution (no `exports`): `main`/`module` for the bare entry, else file probe. */
function resolvesLegacy(
	fs: FileSystem,
	depDir: string,
	pkg: DepManifest,
	subpath: string,
	form: CallForm,
): boolean {
	if (subpath === '') {
		const fields = form === 'require' ? ['main'] : ['module', 'main'];
		const main = resolveLegacyFields(pkg, { browser: false, fields });
		const candidates = [main, 'index.js', 'index.cjs', 'index.mjs'];
		return candidates.some((c) => typeof c === 'string' && probeFile(fs, join(depDir, c)));
	}
	return probeFile(fs, join(depDir, subpath));
}

/** `true` if `base` resolves as a file directly, by extension, or as a directory index. */
function probeFile(fs: FileSystem, base: string): boolean {
	const candidates = [
		base,
		`${base}.js`,
		`${base}.cjs`,
		`${base}.mjs`,
		`${base}.json`,
		join(base, 'index.js'),
		join(base, 'index.cjs'),
		join(base, 'index.mjs'),
	];
	// `isFile` (not mere existence) so a bare directory does not short-circuit probing.
	return candidates.some((c) => fs.isFile(c));
}

/** Splits a specifier into its owning package name and the subpath after it. */
function splitSpecifier(specifier: string): { name: string; subpath: string } {
	const parts = specifier.split('/');
	if (specifier.startsWith('@')) {
		return { name: parts.slice(0, 2).join('/'), subpath: parts.slice(2).join('/') };
	}
	return { name: parts[0] ?? specifier, subpath: parts.slice(1).join('/') };
}
