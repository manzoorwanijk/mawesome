import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquire } from './acquire.ts';
import { declaredDependencies, readManifest } from './manifest.ts';
import { normalizeSpecifier, typesPackageFor } from './normalize.ts';
import { pacoteProvider } from './provider.ts';
import { createTypeResolver, materializeDeps } from './resolve.ts';
import { createRuntimeResolver } from './runtime-resolve.ts';
import { scanRuntimeSurface } from './runtime-surface.ts';
import { scanTypeSurface } from './surface.ts';
import type { AuditOptions, AuditResult, Finding, Surface, UncheckedSpecifier } from './types.ts';

/** A specifier seen on a surface — the shared shape findings are built from. */
interface Seen {
	specifier: string;
	firstSeenIn: string;
}

/**
 * Audits a single target's released surfaces: every external specifier reachable in
 * the package's `.d.ts` files (type surface) and JS files (runtime surface) must
 * resolve through the package's own declared dependencies — materialized fresh, never
 * the author's ambient `node_modules`.
 */
export async function audit(target: string, options: AuditOptions = {}): Promise<AuditResult> {
	const provider = options.provider ?? pacoteProvider;
	const acquired = await acquire(target);
	const workDir = mkdtempSync(join(tmpdir(), 'dep-audit-deps-'));

	try {
		const manifest = readManifest(acquired.root);
		const deps = declaredDependencies(manifest);
		const declared = new Set(deps.map((dep) => dep.name));
		const resolved = await materializeDeps(deps, provider, workDir);
		// Only deps that actually materialized can satisfy a reference.
		const materialized = new Set(
			resolved.filter((dep) => dep.version !== undefined).map((dep) => dep.name),
		);
		const typeResolver = createTypeResolver(workDir);
		const runtimeResolver = createRuntimeResolver(workDir);

		const findings: Finding[] = [];
		const unchecked: UncheckedSpecifier[] = [];
		const isSelf = (name: string): boolean => manifest.name !== undefined && name === manifest.name;

		const typeSurface = scanTypeSurface(acquired.root, manifest);
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

		const runtimeSurface = scanRuntimeSurface(acquired.root, manifest);
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

		return {
			target,
			packageName: manifest.name,
			packageVersion: manifest.version,
			ok: findings.length === 0,
			findings,
			unchecked,
			resolvedDeps: resolved,
		};
	} finally {
		rmSync(workDir, { recursive: true, force: true });
		acquired.cleanup();
	}
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
