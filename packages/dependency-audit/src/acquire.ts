import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pacote from 'pacote';

/** An acquired package root, plus a cleanup for any temp directory created. */
export interface AcquiredPackage {
	/** Absolute path to the directory containing the package's `package.json`. */
	root: string;
	cleanup(): void;
}

/**
 * Resolves a target to an extracted package root.
 * - A **directory** containing `package.json` is used in place (treated as the
 *   already-built/extracted artifact for v1).
 * - A **`.tgz`** is extracted to a fresh temp directory via pacote (no `package/`
 *   prefix; contents land directly in the root).
 *
 * Published specs (`name`, `name@version`) are deferred to a later slice.
 */
export async function acquire(target: string): Promise<AcquiredPackage> {
	const abs = resolve(target);

	if (existsSync(abs) && statSync(abs).isDirectory()) {
		if (!existsSync(join(abs, 'package.json'))) {
			throw new Error(`No package.json found in directory target: ${target}`);
		}
		return { root: abs, cleanup: () => {} };
	}

	if (existsSync(abs) && /\.(tgz|tar\.gz)$/.test(abs)) {
		const dest = mkdtempSync(join(tmpdir(), 'dep-audit-'));
		try {
			await pacote.extract(pathToFileURL(abs).href, dest);
		} catch (error) {
			rmSync(dest, { recursive: true, force: true });
			throw error;
		}
		return { root: dest, cleanup: () => rmSync(dest, { recursive: true, force: true }) };
	}

	if (!isAbsolute(target) && !existsSync(abs)) {
		throw new Error(
			`Target not found: ${target}. v1 accepts a package directory or a .tgz path ` +
				`(published specs like "name@version" are not yet supported).`,
		);
	}

	throw new Error(`Unsupported target: ${target}. Pass a package directory or a .tgz path.`);
}
