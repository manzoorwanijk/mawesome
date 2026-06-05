import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FileSystem } from './fs.ts';

/** `true` if `target` is strictly inside `root` (guards against `../` escapes). */
export function isWithin(root: string, target: string): boolean {
	const rel = relative(resolve(root), resolve(target));
	return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Immediate subdirectories of `path` (used by the TS module-resolution host). */
export function subdirectories(fs: FileSystem, path: string): string[] {
	return fs.listDir(path).filter((name) => fs.isDirectory(join(path, name)));
}

/**
 * Expands an `exports` subpath-pattern target (one `*`, e.g. `./dist/*.js`) into the
 * concrete `./`-prefixed file targets in the package that match it; `*` matches any run of
 * characters including `/` (Node semantics). A target without `*` is returned unchanged.
 */
export function expandPatternTarget(fs: FileSystem, root: string, target: string): string[] {
	const star = target.indexOf('*');
	if (star === -1) {
		return [target];
	}
	// Node allows exactly one `*` in a pattern target; a malformed multi-star target
	// can't be faithfully expanded, so it contributes no entry points.
	if (target.indexOf('*', star + 1) !== -1) {
		return [];
	}
	const prefix = target.slice(0, star).replace(/^\.\//, '');
	const suffix = target.slice(star + 1);
	const out: string[] = [];
	for (const rel of fs.readdirRecursive(root)) {
		const posix = rel.split(sep).join('/');
		if (
			!posix.split('/').includes('node_modules') &&
			posix.length > prefix.length + suffix.length &&
			posix.startsWith(prefix) &&
			posix.endsWith(suffix)
		) {
			out.push(`./${posix}`);
		}
	}
	return out;
}
