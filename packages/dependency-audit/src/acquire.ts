import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import pacote from 'pacote';
import { DEFAULT_EXTRACT_LIMITS, extractTarball } from './extract.ts';
import type { AcquiredSource, ExtractLimits } from './types.ts';

/** An acquired package root, plus a cleanup for any temp directory created. */
export interface AcquiredPackage {
	/** Absolute path to the directory containing the package's `package.json`. */
	root: string;
	source: AcquiredSource;
	cleanup(): void;
}

const TARBALL_RE = /\.(tgz|tar\.gz)$/;
const RECURSIVE = { recursive: true, force: true } as const;

/**
 * Resolves a target to an extracted package root.
 * - A **directory** containing `package.json` is used in place.
 * - A local **`.tgz`** is extracted to a fresh temp directory.
 * - A **published spec** (`name`, `name@version`, `name@tag`, `@scope/name@…`) or an
 *   **`http(s)` tarball URL** is fetched via pacote (reusing npm's auth/cache/dist-tag
 *   resolution and integrity verification); the resolved name, version, tarball URL, and
 *   integrity are recorded (a tag is a moving version).
 *
 * Tarball extraction is bounded by `limits` (a decompression-bomb guard).
 */
export async function acquire(
	target: string,
	limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS,
): Promise<AcquiredPackage> {
	const abs = resolve(target);

	if (existsSync(abs) && statSync(abs).isDirectory()) {
		if (!existsSync(join(abs, 'package.json'))) {
			throw new Error(`No package.json found in directory target: ${target} (${abs})`);
		}
		return { root: abs, source: { kind: 'directory' }, cleanup: () => {} };
	}

	if (existsSync(abs) && TARBALL_RE.test(abs)) {
		const root = await extractInto(readFileSync(abs), limits);
		return { root, source: { kind: 'tarball' }, cleanup: () => rmSync(root, RECURSIVE) };
	}

	if (!looksLikeSpec(target)) {
		throw new Error(
			`Target not found: ${target}. Pass a package directory, a .tgz path, ` +
				`a published spec (name@version), or an http(s) tarball URL.`,
		);
	}

	// Registry spec or remote tarball — pacote resolves, verifies, and returns the bytes.
	const fetched = await pacote.tarball(target);
	const root = await extractInto(fetched, limits);
	const pkg = readPackageJson(root);
	return {
		root,
		source: {
			kind: 'spec',
			resolved: {
				name: pkg.name,
				version: pkg.version,
				tarball: fetched.resolved,
				integrity: fetched.integrity,
			},
		},
		cleanup: () => rmSync(root, RECURSIVE),
	};
}

/** Extracts a tarball buffer into a fresh temp dir, cleaning up on failure. */
async function extractInto(tarball: Uint8Array, limits: ExtractLimits): Promise<string> {
	const dest = mkdtempSync(join(tmpdir(), 'dep-audit-'));
	try {
		await extractTarball(tarball, dest, limits);
		return dest;
	} catch (error) {
		rmSync(dest, RECURSIVE);
		throw error;
	}
}

function readPackageJson(dir: string): { name?: string; version?: string } {
	return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
		name?: string;
		version?: string;
	};
}

/**
 * Distinguishes a package spec / URL from a local path. An `http(s)` URL or a bare
 * `name`/`name@version`/`@scope/name` is a spec; anything ending in `.tgz`/`.tar.gz`,
 * starting with `.`, `/`, or a Windows drive letter (`C:`) is a local path — so a missing
 * one errors clearly instead of becoming a confusing registry lookup.
 */
export function looksLikeSpec(target: string): boolean {
	if (/^https?:\/\//i.test(target)) {
		return true;
	}
	if (
		TARBALL_RE.test(target) ||
		target.startsWith('.') ||
		target.startsWith('/') ||
		isAbsolute(target) ||
		/^[a-zA-Z]:/.test(target)
	) {
		return false;
	}
	return true;
}
