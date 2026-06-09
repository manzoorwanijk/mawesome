import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import packlist from 'npm-packlist';

/**
 * Computes the files `npm publish` would include for the package at `root`, as package-relative
 * POSIX paths — so a directory audit can be restricted to the publish set, matching what a packed
 * `.tgz` of the same package would contain.
 *
 * Returns `undefined` when the set can't be computed (a malformed manifest, an npm-packlist
 * failure), so the caller falls back to scanning every file on disk. Reads the file tree only —
 * it never runs `prepack`/`prepare` or any lifecycle script.
 */
export async function computePackSet(root: string): Promise<ReadonlySet<string> | undefined> {
	try {
		const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<
			string,
			unknown
		>;
		/*
		 * A minimal Arborist-tree-like node: the package root + its manifest, a project root.
		 * npm-packlist derives the publish set from `files`/`.npmignore` and npm's always-include/
		 * exclude defaults off this. `bin` is normalized to the map form npm-packlist expects (a real
		 * Arborist hands it a normalized manifest), so a string `bin` is still force-included.
		 */
		const files = await packlist({
			path: root,
			package: { ...manifest, main: cleanTarget(manifest['main']), bin: normalizeBin(manifest) },
			isProjectRoot: true,
			edgesOut: new Map(),
		});
		return new Set(files);
	} catch {
		/*
		 * Any failure — a malformed manifest, or a `bundleDependencies` package (npm-packlist needs a
		 * real Arborist tree to resolve those) — degrades to `undefined` so the caller scans every file.
		 */
		return undefined;
	}
}

/**
 * Normalizes `package.bin` the way a real Arborist-read manifest would, so npm-packlist force-includes it.
 * A string `bin` becomes `{ <unscoped name>: <path> }`, and every path drops a leading `./` — npm-packlist builds the include rule as `!/<path>`, which a `./`-prefixed path would break. A missing `bin` passes through.
 */
function normalizeBin(manifest: Record<string, unknown>): unknown {
	const bin = manifest['bin'];
	if (typeof bin === 'string') {
		const name = typeof manifest['name'] === 'string' ? manifest['name'] : '';
		const unscoped = name.startsWith('@') ? (name.split('/')[1] ?? name) : name;
		return { [unscoped]: cleanTarget(bin) };
	}
	if (bin !== null && typeof bin === 'object') {
		return Object.fromEntries(
			Object.entries(bin as Record<string, unknown>).map(([key, value]) => [
				key,
				cleanTarget(value),
			]),
		);
	}
	return bin;
}

/** Drops a leading `./` from a manifest target path (npm-packlist's include rules need a clean path). */
function cleanTarget(target: unknown): unknown {
	return typeof target === 'string' && target.startsWith('./') ? target.slice(2) : target;
}
