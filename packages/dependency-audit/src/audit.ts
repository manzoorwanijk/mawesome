import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquire } from './acquire.ts';
import { declaredDependencies, readManifest } from './manifest.ts';
import { normalizeSpecifier, typesPackageFor } from './normalize.ts';
import { pacoteProvider } from './provider.ts';
import { createTypeResolver } from './resolve.ts';
import type { ExternalSpecifier } from './surface.ts';
import { scanTypeSurface } from './surface.ts';
import type { AuditOptions, AuditResult, Finding } from './types.ts';

/**
 * Audits a single target's released **type** surface: every external specifier
 * reachable in the package's `.d.ts` files must resolve to a declaration through
 * the package's own declared dependencies.
 */
export async function audit(target: string, options: AuditOptions = {}): Promise<AuditResult> {
	const provider = options.provider ?? pacoteProvider;
	const acquired = await acquire(target);
	const workDir = mkdtempSync(join(tmpdir(), 'dep-audit-deps-'));

	try {
		const manifest = readManifest(acquired.root);
		const deps = declaredDependencies(manifest);
		const declared = new Set(deps.map((dep) => dep.name));
		const surface = scanTypeSurface(acquired.root, manifest);
		const { resolver, resolved } = await createTypeResolver(deps, provider, workDir);
		// Only deps that actually materialized can satisfy a reference.
		const materialized = new Set(
			resolved.filter((dep) => dep.version !== undefined).map((dep) => dep.name),
		);

		const findings: Finding[] = [];
		for (const external of surface.externals) {
			const normalized = normalizeSpecifier(external.specifier);
			if (normalized === null) {
				continue;
			}
			// Self-reference resolution (a package importing its own name) is deferred.
			if (manifest.name !== undefined && normalized.packageName === manifest.name) {
				continue;
			}
			if (external.kind === 'type-reference') {
				if (!resolver.resolvesTypeReference(external.specifier)) {
					findings.push(unresolvedFinding(external, normalized.packageName, declared));
				}
				continue;
			}
			if (normalized.isBuiltin) {
				// A builtin on the type surface needs @types/node; ambient `declare module`s
				// are not found by module resolution, so test materialization, not resolution.
				if (!materialized.has('@types/node')) {
					findings.push(builtinFinding(external, normalized.packageName));
				}
				continue;
			}
			if (!resolver.resolvesToDeclaration(external.specifier)) {
				findings.push(unresolvedFinding(external, normalized.packageName, declared));
			}
		}

		return {
			target,
			packageName: manifest.name,
			packageVersion: manifest.version,
			ok: findings.length === 0,
			findings,
			unchecked: surface.unchecked,
			resolvedDeps: resolved,
		};
	} finally {
		rmSync(workDir, { recursive: true, force: true });
		acquired.cleanup();
	}
}

function builtinFinding(external: ExternalSpecifier, packageName: string): Finding {
	return {
		specifier: external.specifier,
		packageName,
		surface: 'types',
		kind: 'undeclared',
		firstSeenIn: external.firstSeenIn,
		suggestion: `declare "@types/node" (the declaration references the Node builtin "${packageName}")`,
	};
}

function unresolvedFinding(
	external: ExternalSpecifier,
	packageName: string,
	declared: Set<string>,
): Finding {
	const typesPackage = typesPackageFor(packageName);
	const known = declared.has(packageName) || declared.has(typesPackage);
	if (!known) {
		return {
			specifier: external.specifier,
			packageName,
			surface: 'types',
			kind: 'undeclared',
			firstSeenIn: external.firstSeenIn,
			suggestion: `declare "${packageName}"${
				packageName.startsWith('@types/') ? '' : ` (or "${typesPackage}" if it ships no types)`
			}`,
		};
	}
	return {
		specifier: external.specifier,
		packageName,
		surface: 'types',
		kind: 'missing-types',
		firstSeenIn: external.firstSeenIn,
		suggestion: `"${packageName}" is declared but provides no resolvable declarations for "${external.specifier}"; add "${typesPackage}" or a version that ships types`,
	};
}
