import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
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
		try {
			return readdirSync(path, { recursive: true }).map(String);
		} catch {
			return [];
		}
	},
	realpath(path) {
		try {
			return realpathSync(path);
		} catch {
			return path;
		}
	},
};
