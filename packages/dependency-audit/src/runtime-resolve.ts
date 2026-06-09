import { join } from 'node:path';
import { exports as resolveExports, legacy as resolveLegacyFields } from 'resolve.exports';
import type { FileSystem } from './fs.ts';
import type { CallForm } from './runtime-surface.ts';
import type { UnresolvedReason } from './types.ts';

/** The outcome of resolving a runtime specifier: resolved, or unresolved with a cause when known. */
export interface RuntimeResolution {
	resolved: boolean;
	/** Set only when unresolved *and* the cause is determinable. */
	reason?: UnresolvedReason;
}

/** Resolves runtime specifiers against the materialized declared-dependency tree. */
export interface RuntimeResolver {
	/** Resolves `specifier` in the declared dep for the call `form`, classifying any failure. */
	resolvesRuntime(specifier: string, form: CallForm): RuntimeResolution;
}

interface DepManifest {
	name?: string;
	main?: string;
	module?: string;
	exports?: unknown;
}

/** Per-form probe verdict: resolved to a real file, mapped-but-missing, or not exposed at all. */
type Probe = 'ok' | 'file-missing' | 'not-exposed';

/**
 * Builds a runtime resolver over an already-materialized `<workDir>`.
 * For each declared dep it honors the package's own `exports` for the active condition set (`import` vs `require`), falling back to legacy `main`/`module` + index probing.
 * On failure it re-probes the *opposite* call form to tell an ESM/CJS condition mismatch apart from a genuinely-absent subpath or file.
 */
export function createRuntimeResolver(
	fs: FileSystem,
	workDir: string,
	conditions: readonly string[] = [],
): RuntimeResolver {
	const nodeModules = join(workDir, 'node_modules');
	const extraConditions = conditions.length > 0 ? [...conditions] : undefined;

	const probe = (depDir: string, pkg: DepManifest, subpath: string, form: CallForm): Probe =>
		pkg.exports !== undefined
			? probeExports(fs, depDir, pkg, subpath, form, extraConditions)
			: probeLegacy(fs, depDir, pkg, subpath, form);

	return {
		resolvesRuntime(specifier: string, form: CallForm): RuntimeResolution {
			const { name, subpath } = splitSpecifier(specifier);
			const depDir = join(nodeModules, name);
			const manifestPath = join(depDir, 'package.json');
			if (!fs.isFile(manifestPath)) {
				// The package isn't in the materialized tree — unresolvable, cause indeterminate.
				return { resolved: false };
			}
			const pkg = JSON.parse(fs.readFile(manifestPath)) as DepManifest;

			const current = probe(depDir, pkg, subpath, form);
			if (current === 'ok') {
				return { resolved: true };
			}
			/*
			 * A target mapped under the requested form but missing on disk is a missing file — full stop.
			 * The requested condition *is* present, so this is a build/packaging gap, not a condition mismatch.
			 */
			if (current === 'file-missing') {
				return { resolved: false, reason: 'file-missing' };
			}
			/*
			 * The requested form exposes nothing (only an `exports` map yields `not-exposed`; legacy never does).
			 * If the opposite call form resolves, this is an ESM/CJS condition mismatch — e.g. a `require()` of an `import`-only `exports`.
			 */
			const opposite: CallForm = form === 'require' ? 'import' : 'require';
			const other = probe(depDir, pkg, subpath, opposite);
			if (other === 'ok') {
				return { resolved: false, reason: 'condition-mismatch' };
			}
			if (other === 'file-missing') {
				return { resolved: false, reason: 'file-missing' };
			}
			// Neither call form exposes the subpath.
			return { resolved: false, reason: 'subpath-not-exported' };
		},
	};
}

/**
 * Resolves a specifier against a dep's `exports`.
 * An array target is a fallback list — the first that exists as a file wins.
 * Resolution uses the subpath entry (`.`/`./sub`), not the raw specifier, so an `npm:` alias resolves through the materialized package's own `exports` regardless of its real name (else `resolve.exports` reads the alias key as a missing subpath).
 */
function probeExports(
	fs: FileSystem,
	depDir: string,
	pkg: DepManifest,
	subpath: string,
	form: CallForm,
	extraConditions: string[] | undefined,
): Probe {
	const entry = subpath === '' ? '.' : `./${subpath}`;
	try {
		const targets = resolveExports(pkg, entry, {
			require: form === 'require',
			...(extraConditions !== undefined ? { conditions: extraConditions } : {}),
		});
		if (!Array.isArray(targets) || targets.length === 0) {
			return 'not-exposed';
		}
		return targets.some((t) => fs.isFile(join(depDir, t))) ? 'ok' : 'file-missing';
	} catch {
		// `resolve.exports` throws when no condition/subpath matches — the entry isn't exposed.
		return 'not-exposed';
	}
}

/** Legacy resolution (no `exports`): `main`/`module` for the bare entry, else a file probe. */
function probeLegacy(
	fs: FileSystem,
	depDir: string,
	pkg: DepManifest,
	subpath: string,
	form: CallForm,
): Probe {
	if (subpath === '') {
		const fields = form === 'require' ? ['main'] : ['module', 'main'];
		const main = resolveLegacyFields(pkg, { browser: false, fields });
		const candidates = [main, 'index.js', 'index.cjs', 'index.mjs'];
		return candidates.some((c) => typeof c === 'string' && probeFile(fs, join(depDir, c)))
			? 'ok'
			: 'file-missing';
	}
	return probeFile(fs, join(depDir, subpath)) ? 'ok' : 'file-missing';
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
