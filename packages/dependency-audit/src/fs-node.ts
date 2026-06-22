import { type Dirent, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FileSystem } from './fs.ts';

/** The {@link FileSystem} backed by the real Node filesystem (CLI/library use). */
export const nodeFileSystem: FileSystem = {
	readFile(path) {
		return readFileSync(path, 'utf8');
	},
	isFile(path) {
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	},
	isDirectory(path) {
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	},
	listDir(path) {
		try {
			return readdirSync(path);
		} catch {
			return [];
		}
	},
	readdirRecursive(path) {
		/*
		 * A manual walk, NOT `readdirSync(recursive: true)`: that follows directory symlinks, and a
		 * package's `node_modules` links into a shared store (pnpm's `.store`) whose recursive, cyclic
		 * graph would be traversed in full — enumerating millions of paths and exhausting the heap.
		 * So skip `node_modules` wholesale and never descend a symlink; emit only regular files,
		 * matching the port contract and the in-memory implementation.
		 */
		const out: string[] = [];
		const stack = [path];
		while (stack.length > 0) {
			const dir = stack.pop()!;
			let entries: Dirent[];
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				// An unreadable directory contributes nothing (best-effort, like the old catch).
				continue;
			}
			for (const entry of entries) {
				if (entry.name === 'node_modules' || entry.isSymbolicLink()) {
					continue;
				}
				const abs = join(dir, entry.name);
				if (entry.isDirectory()) {
					stack.push(abs);
				} else if (entry.isFile()) {
					out.push(relative(path, abs));
				}
			}
		}
		return out;
	},
	realpath(path) {
		try {
			return realpathSync(path);
		} catch {
			return path;
		}
	},
};
