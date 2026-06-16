/**
 * The filesystem port. The audit core reads exclusively through this interface, so it
 * runs unchanged over the real Node filesystem (CLI/library) or an in-memory tree (a
 * browser playground). Paths are whatever the active `node:path` produces — POSIX in the
 * browser and on macOS/Linux. The only remaining `node:` import in the browser bundle is
 * `node:path`, which a bundler aliases to `path-browserify`.
 */
export interface FileSystem {
	/** Reads a file as UTF-8. Throws if the path is not a readable file. */
	readFile(path: string): string;
	/** `true` if the path exists and is a regular file. */
	isFile(path: string): boolean;
	/** `true` if the path exists and is a directory. */
	isDirectory(path: string): boolean;
	/** Immediate child names of a directory (`[]` if missing). */
	listDir(path: string): string[];
	/** File paths under `path`, relative to it, recursively. */
	readdirRecursive(path: string): string[];
	/** Best-effort real path; returns the input when unknown. */
	realpath(path: string): string;
}

/** A {@link FileSystem} a dependency provider can materialize packages into. */
export interface WritableFileSystem extends FileSystem {
	/** Writes a UTF-8 file, creating parent directories as needed. */
	writeFile(path: string, content: string): void;
}

/** A node into the in-memory tree: a file (with content) or a directory. */
interface MemoryNode {
	type: 'file' | 'dir';
	content?: string;
}

/*
 * The tree is POSIX-keyed, but the audit core joins paths with the platform's `node:path` — which
 * is win32 (backslashes) when these adapters run on Windows-Node (the test suite). Fold `\` to `/`
 * so a win32-joined lookup still resolves; a browser already passes POSIX paths, so this is a no-op there.
 */
const toPosix = (path: string): string => path.replace(/\\/g, '/');

// Strip trailing slashes so `/a` and `/a/` are the same key; `/` stays `/`.
const norm = (path: string): string => {
	const posix = toPosix(path);
	return posix === '/' ? '/' : posix.replace(/\/+$/, '');
};

/**
 * An in-memory filesystem keyed by absolute POSIX paths — the browser adapter, and the
 * substrate for hermetic tests. Seed files with {@link WritableFileSystem.writeFile}.
 */
export function createMemoryFileSystem(): WritableFileSystem {
	const nodes = new Map<string, MemoryNode>([['/', { type: 'dir' }]]);

	const ensureDir = (dir: string): void => {
		const parts = norm(dir).split('/').filter(Boolean);
		let current = '';
		for (const part of parts) {
			current += `/${part}`;
			if (nodes.get(current)?.type !== 'dir') {
				nodes.set(current, { type: 'dir' });
			}
		}
	};

	return {
		writeFile(path, content) {
			const key = norm(path);
			const slash = key.lastIndexOf('/');
			if (slash > 0) {
				ensureDir(key.slice(0, slash));
			}
			nodes.set(key, { type: 'file', content });
		},
		readFile(path) {
			// Separators are folded to `/`, but a trailing slash is preserved so a file lookup on a
			// directory spelling still misses (matches Node).
			const key = toPosix(path);
			const node = nodes.get(key);
			if (node?.type !== 'file' || node.content === undefined) {
				throw new Error(`ENOENT: no such file: ${path}`);
			}
			return node.content;
		},
		isFile(path) {
			return nodes.get(toPosix(path))?.type === 'file';
		},
		isDirectory(path) {
			return nodes.get(norm(path))?.type === 'dir';
		},
		listDir(path) {
			const base = norm(path);
			const prefix = base === '/' ? '/' : `${base}/`;
			const names = new Set<string>();
			for (const key of nodes.keys()) {
				if (key.startsWith(prefix)) {
					const rest = key.slice(prefix.length);
					const name = rest.split('/', 1)[0];
					if (name !== undefined && name !== '') {
						names.add(name);
					}
				}
			}
			return [...names];
		},
		readdirRecursive(path) {
			const base = norm(path);
			const prefix = base === '/' ? '/' : `${base}/`;
			const out: string[] = [];
			for (const [key, node] of nodes) {
				if (node.type === 'file' && key.startsWith(prefix)) {
					out.push(key.slice(prefix.length));
				}
			}
			return out;
		},
		realpath(path) {
			return path;
		},
	};
}
