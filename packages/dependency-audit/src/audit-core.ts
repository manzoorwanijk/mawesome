import { mapLimit } from './concurrency.ts';
import type { FileSystem } from './fs.ts';
import { partitionIgnored } from './ignore.ts';
import { declaredDependencies, readManifest } from './manifest.ts';
import { emit, type ProgressReporter } from './progress.ts';
import { createNormalizer, typesPackageFor } from './normalize.ts';
import { createTypeResolver, materializeDeps } from './resolve.ts';
import { createRuntimeResolver } from './runtime-resolve.ts';
import { type CallForm, scanRuntimeSurface } from './runtime-surface.ts';
import { scanTypeSurface, type TypeCoverage } from './surface.ts';
import type {
	AcquiredSource,
	AuditResult,
	Finding,
	IgnoreRule,
	Notice,
	RegistryProvider,
	Surface,
	UncheckedSpecifier,
	UnresolvedReason,
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
	/** Extra resolution conditions to activate (e.g. `["browser"]`), added to the defaults. */
	conditions?: readonly string[];
	/** Cap on concurrent dep materializations (default {@link DEFAULT_MATERIALIZE_CONCURRENCY}). */
	materializeConcurrency?: number;
	/** Optional progress sink, notified as deps materialize and surfaces are scanned. */
	progress?: ProgressReporter;
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
	const { provider, workDir, progress } = options;
	const target = options.target ?? root;
	const manifest = readManifest(fs, root);
	const deps = declaredDependencies(manifest);
	const declared = new Set(deps.map((dep) => dep.name));
	emit(progress, { type: 'materialize:start', target, total: deps.length });
	const resolved = await materializeDeps(
		deps,
		provider,
		workDir,
		(done, total) => emit(progress, { type: 'materialize:progress', target, done, total }),
		options.materializeConcurrency,
	);
	// Only deps that actually materialized can satisfy a reference.
	const materialized = new Set(
		resolved.filter((dep) => dep.version !== undefined).map((dep) => dep.name),
	);
	const conditions = options.conditions ?? [];
	const typeResolver = createTypeResolver(fs, workDir, conditions);
	const runtimeResolver = createRuntimeResolver(fs, workDir, conditions);
	const normalizeSpecifier = createNormalizer(options.builtins);

	const findings: Finding[] = [];
	const unchecked: UncheckedSpecifier[] = [];
	const isSelf = (name: string): boolean => manifest.name !== undefined && name === manifest.name;

	emit(progress, { type: 'scan:start', target, surface: 'types' });
	const typeSurface = scanTypeSurface(fs, root, manifest, conditions);
	unchecked.push(...typeSurface.unchecked);
	const notices = typeCoverageNotices(typeSurface.coverage);
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

	emit(progress, { type: 'scan:start', target, surface: 'runtime' });
	const runtimeSurface = scanRuntimeSurface(fs, root, manifest, conditions);
	unchecked.push(...runtimeSurface.unchecked);
	for (const external of runtimeSurface.externals) {
		const normalized = normalizeSpecifier(external.specifier);
		// Node builtins need no declaration on the runtime surface.
		if (normalized === null || normalized.isBuiltin || isSelf(normalized.packageName)) {
			continue;
		}
		const resolution = runtimeResolver.resolvesRuntime(external.specifier, external.form);
		if (!resolution.resolved) {
			findings.push(
				runtimeFinding(
					external,
					normalized.packageName,
					declared,
					external.form,
					resolution.reason,
				),
			);
		}
	}

	/*
	 * Suppress intentional findings first, then refine only the survivors, then re-check them.
	 * Refining before this would let a `{ kind: "missing-types" }` rule silently stop matching a
	 * finding reclassified to `types-unavailable` — turning a previously-ignored gap into a failure.
	 * The second pass catches a `{ kind: "types-unavailable" }` rule against the now-refined kind.
	 */
	const rules = options.ignore ?? [];
	const context = { name: manifest.name, target };
	const suppressed = partitionIgnored(findings, rules, context);
	await refineMissingTypes(suppressed.findings, provider, declared);
	const partitioned = partitionIgnored(suppressed.findings, rules, context);
	return {
		target,
		source: options.source ?? { kind: 'directory' },
		packageName: manifest.name,
		packageVersion: manifest.version,
		ok: partitioned.findings.length === 0,
		findings: partitioned.findings,
		ignored: [...suppressed.ignored, ...partitioned.ignored],
		unchecked,
		notices,
		resolvedDeps: resolved,
	};
}

/** Maps a type-surface coverage verdict to a user-facing notice (none when fully covered). */
function typeCoverageNotices(coverage: TypeCoverage): Notice[] {
	if (coverage === 'not-built') {
		return [
			{
				kind: 'types-not-built',
				surface: 'types',
				message:
					'declares type declarations, but none resolve from the package root — the build output looks missing (build the package before auditing, or fix the declared types path)',
			},
		];
	}
	if (coverage === 'unreachable') {
		return [
			{
				kind: 'types-unreachable',
				surface: 'types',
				message:
					'ships .d.ts files, but no "types" field or "exports" types condition exposes them — consumers cannot resolve its types (a likely packaging gap)',
			},
		];
	}
	return [];
}

/** Cap on concurrent registry existence probes, to bound load on the shared registry. */
const TYPES_PROBE_CONCURRENCY = 8;

type Existence = 'exists' | 'absent' | 'unknown';

/**
 * Refines `missing-types` findings using the provider's optional registry probe.
 * When the `@types/*` companion does not exist, the gap is not fixable by declaring a dependency, so the finding is reclassified `types-unavailable` with honest advice.
 * An `exists`/`unknown` result (or a provider without the capability — e.g. the browser default) leaves the conservative `missing-types` finding unchanged.
 */
async function refineMissingTypes(
	findings: Finding[],
	provider: RegistryProvider,
	declared: Set<string>,
): Promise<void> {
	if (provider.packageExists === undefined) {
		return;
	}
	// Bind to preserve the receiver — a class-backed custom provider may use `this`.
	const probe = provider.packageExists.bind(provider);
	// Distinct packages whose `@types/*` companion we'd suggest and that isn't already declared.
	const names = [
		...new Set(
			findings
				.filter((f) => f.kind === 'missing-types' && !declared.has(typesPackageFor(f.packageName)))
				.map((f) => f.packageName),
		),
	];
	if (names.length === 0) {
		return;
	}
	const availability = new Map<string, Existence>();
	await mapLimit(names, TYPES_PROBE_CONCURRENCY, async (name) => {
		availability.set(name, await probe(typesPackageFor(name)));
	});
	for (const candidate of findings) {
		if (
			candidate.kind === 'missing-types' &&
			availability.get(candidate.packageName) === 'absent'
		) {
			candidate.kind = 'types-unavailable';
			candidate.suggestion = typesUnavailableSuggestion(candidate.packageName);
		}
	}
}

function typesUnavailableSuggestion(packageName: string): string {
	const typesPackage = typesPackageFor(packageName);
	return `"${packageName}" publishes no types and no "${typesPackage}" exists on the registry — not fixable by declaring a dependency; ship types upstream, or add a local ambient \`declare module "${packageName}"\``;
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

function runtimeFinding(
	seen: Seen,
	packageName: string,
	declared: Set<string>,
	form: CallForm,
	reason: UnresolvedReason | undefined,
): Finding {
	if (!declared.has(packageName)) {
		return finding(
			seen,
			packageName,
			'runtime',
			'undeclared',
			`declare "${packageName}" (it is imported at runtime but not a declared dependency)`,
		);
	}
	const result = finding(
		seen,
		packageName,
		'runtime',
		'unresolved',
		unresolvedSuggestion(seen.specifier, packageName, form, reason),
	);
	if (reason !== undefined) {
		result.reason = reason;
	}
	return result;
}

/** The remediation hint for an `unresolved` finding, named by its classified cause. */
function unresolvedSuggestion(
	specifier: string,
	packageName: string,
	form: CallForm,
	reason: UnresolvedReason | undefined,
): string {
	switch (reason) {
		case 'condition-mismatch': {
			const used = form === 'require' ? 'require (CJS)' : 'import (ESM)';
			const works = form === 'require' ? 'import (ESM)' : 'require (CJS)';
			const missing = form === 'require' ? 'require' : 'import';
			return `"${specifier}" resolves for ${works} but was loaded via ${used} — "${packageName}" exposes no "${missing}" export condition (ESM/CJS mismatch)`;
		}
		case 'subpath-not-exported':
			return `"${specifier}" is not exported by "${packageName}" (its "exports" map does not expose this subpath)`;
		case 'file-missing':
			return `"${specifier}" maps through "${packageName}" to a target file that is missing`;
		default:
			return `"${specifier}" does not resolve through declared "${packageName}" (subpath not exported, or the target file is missing)`;
	}
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
