import { join } from 'node:path';
import ts from 'typescript';
import type { DeclaredDependency } from './manifest.ts';
import type { RegistryProvider, ResolvedDependency } from './types.ts';

const DECLARATION_EXTENSIONS = new Set<string>([
	ts.Extension.Dts,
	ts.Extension.Dmts,
	ts.Extension.Dcts,
]);

/** Resolves bare specifiers against a freshly-materialized declared-dependency tree. */
export interface TypeResolver {
	/** `true` if `specifier` resolves to a declaration file in the declared tree. */
	resolvesToDeclaration(specifier: string): boolean;
	/** `true` if a `/// <reference types="name" />` directive resolves (e.g. via `@types/*`). */
	resolvesTypeReference(name: string): boolean;
}

/**
 * Materializes every declared dependency into `<workDir>/node_modules`, in parallel.
 * Both the type and runtime resolvers then run against this one shared tree, derived
 * from the target's declared ranges — never the author's ambient `node_modules`.
 */
export async function materializeDeps(
	deps: DeclaredDependency[],
	provider: RegistryProvider,
	workDir: string,
): Promise<ResolvedDependency[]> {
	return Promise.all(
		deps.map(async (dep) => ({
			name: dep.name,
			range: dep.range,
			version: await provider.materialize(dep.name, dep.range, workDir),
		})),
	);
}

/**
 * Builds a TypeScript-accurate resolver over an already-materialized `<workDir>`.
 * Resolution uses NodeNext from an ESM (`.d.mts`) probe context, so `react` falls
 * back to `@types/react` exactly as a consumer's type-checker would.
 */
export function createTypeResolver(workDir: string): TypeResolver {
	const options: ts.CompilerOptions = {
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		module: ts.ModuleKind.NodeNext,
		target: ts.ScriptTarget.ESNext,
	};
	const host: ts.ModuleResolutionHost = {
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		directoryExists: ts.sys.directoryExists,
		getDirectories: ts.sys.getDirectories,
		realpath: ts.sys.realpath ?? ((path: string) => path),
		getCurrentDirectory: () => workDir,
		useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
	};
	// The probe is never read; its path only sets the (ESM) resolution context.
	const containingFile = join(workDir, '__dependency_audit_probe__.d.mts');
	const moduleCache = ts.createModuleResolutionCache(workDir, (x) => x, options);
	const typeRefCache = ts.createTypeReferenceDirectiveResolutionCache(
		workDir,
		(x) => x,
		options,
		moduleCache.getPackageJsonInfoCache(),
	);

	const resolver: TypeResolver = {
		resolvesToDeclaration(specifier: string): boolean {
			const result = ts.resolveModuleName(specifier, containingFile, options, host, moduleCache);
			const mod = result.resolvedModule;
			return mod !== undefined && DECLARATION_EXTENSIONS.has(mod.extension);
		},
		resolvesTypeReference(name: string): boolean {
			const result = ts.resolveTypeReferenceDirective(
				name,
				containingFile,
				options,
				host,
				undefined,
				typeRefCache,
			);
			return result.resolvedTypeReferenceDirective?.resolvedFileName !== undefined;
		},
	};

	return resolver;
}
