import { isAbsolute, join, relative, resolve } from 'node:path';
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
