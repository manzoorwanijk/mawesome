import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The subset of `package.json` fields the audit reads. */
export interface Manifest {
	name?: string;
	version?: string;
	type?: string;
	main?: string;
	module?: string;
	types?: string;
	typings?: string;
	exports?: unknown;
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

/** A declared dependency name paired with its declared range. */
export interface DeclaredDependency {
	name: string;
	range: string;
}

/** Reads and parses the `package.json` at the package root. */
export function readManifest(root: string): Manifest {
	const raw = readFileSync(join(root, 'package.json'), 'utf8');
	return JSON.parse(raw) as Manifest;
}

/**
 * The dependencies a consumer installs: production, peer, and optional.
 * `devDependencies` never satisfies a released import, so it is excluded.
 * Later fields override earlier ones on key collision (last wins).
 */
export function declaredDependencies(manifest: Manifest): DeclaredDependency[] {
	const merged = new Map<string, string>();
	for (const field of [
		manifest.dependencies,
		manifest.peerDependencies,
		manifest.optionalDependencies,
	]) {
		for (const [name, range] of Object.entries(field ?? {})) {
			merged.set(name, range);
		}
	}
	return [...merged].map(([name, range]) => ({ name, range }));
}
