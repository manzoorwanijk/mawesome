import { join } from 'node:path';
import ts from 'typescript';
import { mapLimit } from './concurrency.ts';
import type { FileSystem } from './fs.ts';
import { subdirectories } from './fsutil.ts';
import type { DeclaredDependency } from './manifest.ts';
import type { RegistryProvider, ResolvedDependency, TypeResolutionMode } from './types.ts';

/** Default cap on concurrent dependency materializations, to bound load on the shared registry cache. */
export const DEFAULT_MATERIALIZE_CONCURRENCY = 12;

const DECLARATION_EXTENSIONS = new Set<string>([
	ts.Extension.Dts,
	ts.Extension.Dmts,
	ts.Extension.Dcts,
]);

/** Resolves bare specifiers against a freshly-materialized declared-dependency tree. */
export interface TypeResolver {
	/** `true` if `specifier` resolves to a declaration file in the declared tree; an explicit `resolution-mode` attribute overrides the profile's ESM default. */
	resolvesToDeclaration(specifier: string, resolutionMode?: TypeResolutionMode): boolean;
	/** `true` if a `/// <reference types="name" />` directive resolves (e.g. via `@types/*`); a `resolution-mode` attribute overrides the same ESM default. */
	resolvesTypeReference(name: string, resolutionMode?: TypeResolutionMode): boolean;
}

/** Maps a port-level resolution mode to TypeScript's; an absent override means the profile default (ESM). */
function toTsResolutionMode(mode: TypeResolutionMode | undefined): ts.ResolutionMode {
	return mode === 'require' ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext;
}

/**
 * Materializes every declared dependency into `<workDir>/node_modules`, in parallel.
 * Both the type and runtime resolvers then run against this one shared tree, derived from the target's declared ranges — never the author's ambient `node_modules`.
 *
 * Every dep is awaited to completion before this returns or throws, even when one fails: a failure is captured and rethrown only after the rest settle.
 * That keeps progress honest (the count always reaches `total`) and avoids leaving a surviving download writing into `workDir` after the caller starts tearing it down.
 * `onProgress` (if given) fires with the running completion count after each dep settles, including failures.
 * `concurrency` caps in-flight materializations (default {@link DEFAULT_MATERIALIZE_CONCURRENCY}); lower it to ease the shared-cache load on a large batch.
 */
export async function materializeDeps(
	deps: DeclaredDependency[],
	provider: RegistryProvider,
	workDir: string,
	onProgress?: (done: number, total: number) => void,
	concurrency: number = DEFAULT_MATERIALIZE_CONCURRENCY,
): Promise<ResolvedDependency[]> {
	const total = deps.length;
	let done = 0;
	let failed = false;
	let firstError: unknown;
	const resolved = await mapLimit(deps, concurrency, async (dep) => {
		try {
			const version = await provider.materialize(dep.name, dep.range, workDir);
			return { name: dep.name, range: dep.range, version };
		} catch (error) {
			// Defer the throw so other in-flight deps still settle (no orphaned writes; honest count).
			if (!failed) {
				failed = true;
				firstError = error;
			}
			return { name: dep.name, range: dep.range, version: undefined };
		} finally {
			done++;
			onProgress?.(done, total);
		}
	});
	if (failed) {
		throw firstError;
	}
	return resolved;
}

/**
 * Builds a TypeScript-accurate resolver over an already-materialized `<workDir>`.
 * Resolution runs NodeNext in ESM mode, matching the profile the type surface is scanned under (`import`-condition entry points; see `ACTIVE_CONDITIONS` in surface.ts) — `ts.resolveModuleName` never infers mode from the probe file's extension, so the mode is passed explicitly.
 * `react` falls back to `@types/react` exactly as a consumer's type-checker would.
 */
export function createTypeResolver(
	fs: FileSystem,
	workDir: string,
	conditions: readonly string[] = [],
): TypeResolver {
	const options: ts.CompilerOptions = {
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		module: ts.ModuleKind.NodeNext,
		target: ts.ScriptTarget.ESNext,
		// Activate extra `exports` conditions (e.g. `browser`) on top of NodeNext's defaults.
		...(conditions.length > 0 ? { customConditions: [...conditions] } : {}),
	};
	// The resolution host reads through the FS port, so resolution is identical over the
	// real Node filesystem or an in-memory tree (browser).
	const host: ts.ModuleResolutionHost = {
		fileExists: (path) => fs.isFile(path),
		readFile: (path) => (fs.isFile(path) ? fs.readFile(path) : undefined),
		directoryExists: (path) => fs.isDirectory(path),
		getDirectories: (path) => subdirectories(fs, path),
		realpath: (path) => fs.realpath(path),
		getCurrentDirectory: () => workDir,
		useCaseSensitiveFileNames: true,
	};
	// The probe is never read; its path only anchors resolution at `workDir` (mode is passed explicitly, never inferred from the extension).
	const containingFile = join(workDir, '__dependency_audit_probe__.d.mts');
	const moduleCache = ts.createModuleResolutionCache(workDir, (x) => x, options);
	const typeRefCache = ts.createTypeReferenceDirectiveResolutionCache(
		workDir,
		(x) => x,
		options,
		moduleCache.getPackageJsonInfoCache(),
	);

	const resolver: TypeResolver = {
		resolvesToDeclaration(specifier: string, resolutionMode?: TypeResolutionMode): boolean {
			const result = ts.resolveModuleName(
				specifier,
				containingFile,
				options,
				host,
				moduleCache,
				undefined,
				toTsResolutionMode(resolutionMode),
			);
			const mod = result.resolvedModule;
			return mod !== undefined && DECLARATION_EXTENSIONS.has(mod.extension);
		},
		resolvesTypeReference(name: string, resolutionMode?: TypeResolutionMode): boolean {
			const result = ts.resolveTypeReferenceDirective(
				name,
				containingFile,
				options,
				host,
				undefined,
				typeRefCache,
				toTsResolutionMode(resolutionMode),
			);
			return result.resolvedTypeReferenceDirective?.resolvedFileName !== undefined;
		},
	};

	return resolver;
}
