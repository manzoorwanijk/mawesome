import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

/** `true` if `path` exists and is a regular file (not a directory). */
export function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** `true` if `target` is strictly inside `root` (guards against `../` escapes). */
export function isWithin(root: string, target: string): boolean {
	const rel = relative(resolve(root), resolve(target));
	return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
