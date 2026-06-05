import type { FileSystem } from './fs.ts';
import { partitionIgnored } from './ignore.ts';
import { declaredDependencies, readManifest } from './manifest.ts';
import { createNormalizer, typesPackageFor } from './normalize.ts';
import { createTypeResolver, materializeDeps } from './resolve.ts';
import { createRuntimeResolver } from './runtime-resolve.ts';
import { scanRuntimeSurface } from './runtime-surface.ts';
import { scanTypeSurface } from './surface.ts';
import type {
	AcquiredSource,
	AuditResult,
	Finding,
	IgnoreRule,
	RegistryProvider,
	Surface,
	UncheckedSpecifier,
} from './types.ts';

/** Options for {@link auditPackage}. */
export interface AuditPackageOptions {
	/** Materializes declared deps into `workDir/node_modules`. */
	provider: RegistryProvider;
	/** Where the provider materializes deps (a real temp dir on Node; any path in memory). */
	workDir: string;
	/** Label for the result's `target` field. Defaults to `root`. */
	target?: string;
	/** How the package was acquired (recorded on the result). Defaults to `directory`. */
	source?: AcquiredSource;
	/** Rules that suppress intentional findings (moved to `result.ignored`). */
	ignore?: IgnoreRule[];
	/** Node builtin names (the Node entry injects the live `builtinModules`; default hardcoded). */
	builtins?: readonly string[];
}

/** A specifier seen on a surface — the shared shape findings are built from. */
interface Seen {
	specifier: string;
	firstSeenIn: string;
}

/**
 * Audits an already-extracted package `root`, reading entirely through the `fs` port —
 * no `node:fs`, acquisition, or temp management — so it runs identically on Node and in
 * the browser. The Node entry (`audit`) wraps this with acquisition + a temp dir; a
 * browser host wraps it with an in-memory filesystem and a fetch-based provider.
 */
export async function auditPackage(
	fs: FileSystem,
	root: string,
	options: AuditPackageOptions,
): Promise<AuditResult> {
	const { provider, workDir } = options;
	const manifest = readManifest(fs, root);
	const deps = declaredDependencies(manifest);
	const declared = new Set(deps.map((dep) => dep.name));
	const resolved = await materializeDeps(deps, provider, workDir);
	// Only deps that actually materialized can satisfy a reference.
	const materialized = new Set(
		resolved.filter((dep) => dep.version !== undefined).map((dep) => dep.name),
	);
	const typeResolver = createTypeResolver(fs, workDir);
	const runtimeResolver = createRuntimeResolver(fs, workDir);
	const normalizeSpecifier = createNormalizer(options.builtins);

	const findings: Finding[] = [];
	const unchecked: UncheckedSpecifier[] = [];
	const isSelf = (name: string): boolean => manifest.name !== undefined && name === manifest.name;

	const typeSurface = scanTypeSurface(fs, root, manifest);
	unchecked.push(...typeSurface.unchecked);
	for (const external of typeSurface.externals) {
		const normalized = normalizeSpecifier(external.specifier);
		if (normalized === null || isSelf(normalized.packageName)) {
			continue;
		}
		if (external.kind === 'type-reference') {
			if (!typeResolver.resolvesTypeReference(external.specifier)) {
				findings.push(typeFinding(external, normalized.packageName, declared));
			}
			continue;
		}
		if (normalized.isBuiltin) {
			// A builtin on the type surface needs @types/node; ambient `declare module`s
			// are not found by module resolution, so test materialization, not resolution.
			if (!materialized.has('@types/node')) {
				findings.push(builtinTypeFinding(external, normalized.packageName));
			}
			continue;
		}
		if (!typeResolver.resolvesToDeclaration(external.specifier)) {
			findings.push(typeFinding(external, normalized.packageName, declared));
		}
	}

	const runtimeSurface = scanRuntimeSurface(fs, root, manifest);
	unchecked.push(...runtimeSurface.unchecked);
	for (const external of runtimeSurface.externals) {
		const normalized = normalizeSpecifier(external.specifier);
		// Node builtins need no declaration on the runtime surface.
		if (normalized === null || normalized.isBuiltin || isSelf(normalized.packageName)) {
			continue;
		}
		if (!runtimeResolver.resolvesRuntime(external.specifier, external.form)) {
			findings.push(runtimeFinding(external, normalized.packageName, declared));
		}
	}

	const partitioned = partitionIgnored(findings, options.ignore ?? []);
	return {
		target: options.target ?? root,
		source: options.source ?? { kind: 'directory' },
		packageName: manifest.name,
		packageVersion: manifest.version,
		ok: partitioned.findings.length === 0,
		findings: partitioned.findings,
		ignored: partitioned.ignored,
		unchecked,
		resolvedDeps: resolved,
	};
}

function builtinTypeFinding(seen: Seen, packageName: string): Finding {
	return {
		specifier: seen.specifier,
		packageName,
		surface: 'types',
		kind: 'undeclared',
		firstSeenIn: seen.firstSeenIn,
		suggestion: `declare "@types/node" (the declaration references the Node builtin "${packageName}")`,
	};
}

function typeFinding(seen: Seen, packageName: string, declared: Set<string>): Finding {
	const typesPackage = typesPackageFor(packageName);
	const known = declared.has(packageName) || declared.has(typesPackage);
	if (!known) {
		return finding(
			seen,
			packageName,
			'types',
			'undeclared',
			declareHint(packageName, typesPackage),
		);
	}
	return finding(
		seen,
		packageName,
		'types',
		'missing-types',
		`"${packageName}" is declared but provides no resolvable declarations for "${seen.specifier}"; add "${typesPackage}" or a version that ships types`,
	);
}

function runtimeFinding(seen: Seen, packageName: string, declared: Set<string>): Finding {
	if (!declared.has(packageName)) {
		return finding(
			seen,
			packageName,
			'runtime',
			'undeclared',
			`declare "${packageName}" (it is imported at runtime but not a declared dependency)`,
		);
	}
	return finding(
		seen,
		packageName,
		'runtime',
		'unresolved',
		`"${seen.specifier}" does not resolve through declared "${packageName}" (subpath not exported, or the target file is missing)`,
	);
}

function declareHint(packageName: string, typesPackage: string): string {
	return `declare "${packageName}"${
		packageName.startsWith('@types/') ? '' : ` (or "${typesPackage}" if it ships no types)`
	}`;
}

function finding(
	seen: Seen,
	packageName: string,
	surface: Surface,
	kind: Finding['kind'],
	suggestion: string,
): Finding {
	return {
		specifier: seen.specifier,
		packageName,
		surface,
		kind,
		firstSeenIn: seen.firstSeenIn,
		suggestion,
	};
}
