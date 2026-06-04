/**
 * Enforces the root dependency policy (see AGENTS.md "Dependency isolation").
 * The root package.json must declare no `dependencies` and only `@changesets/*`
 * `devDependencies` — everything else belongs in a workspace, so Node's upward
 * module resolution can't hand a package a dependency it never declared.
 * Run directly on Node (type-stripped): `node tools/repo/scripts/check-root-deps.ts`.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

/** Scope prefixes allowed in the root `devDependencies`. */
const ALLOWED_DEV_DEP_PREFIXES = ['@changesets/'];

interface RootManifest {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

/** Returns a list of policy violations (empty when the manifest is compliant). */
export function findRootDepViolations(pkg: RootManifest): string[] {
	const violations: string[] = [];

	const deps = Object.keys(pkg.dependencies ?? {});
	if (deps.length > 0) {
		violations.push(`root "dependencies" must be empty, found: ${deps.join(', ')}`);
	}

	for (const name of Object.keys(pkg.devDependencies ?? {})) {
		const allowed = ALLOWED_DEV_DEP_PREFIXES.some((prefix) => name.startsWith(prefix));
		if (!allowed) {
			violations.push(`root devDependency "${name}" is outside the @changesets/* allowlist`);
		}
	}

	return violations;
}

/** Resolves the manifest to check: `--manifest <path>` (cwd-relative) or the repo root. */
function resolveManifestUrl(manifest: string | undefined): URL {
	if (manifest !== undefined) {
		return new URL(manifest, `file://${process.cwd()}/`);
	}
	return new URL('../../../package.json', import.meta.url);
}

function main(): void {
	const { values } = parseArgs({ options: { manifest: { type: 'string', short: 'm' } } });
	const pkg = JSON.parse(readFileSync(resolveManifestUrl(values.manifest), 'utf8')) as RootManifest;
	const violations = findRootDepViolations(pkg);

	if (violations.length > 0) {
		console.error('check-root-deps: root package.json violates the dependency policy:');
		for (const violation of violations) {
			console.error(`  - ${violation}`);
		}
		process.exit(1);
	}

	console.log(
		'check-root-deps: OK (no root dependencies; devDependencies within @changesets/* allowlist)',
	);
}

if (import.meta.main) {
	main();
}
