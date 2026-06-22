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
	/**
	 * Regular-file paths under `path`, relative to it, recursively. Implementations must not follow
	 * symlinks and must skip `node_modules`: a real package tree links into a shared dependency store
	 * (pnpm's `.store`, or npm's linked strategy) whose cyclic graph would otherwise be walked in full.
	 */
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

// Strip trailing slashes so `/a` and `/a/` are the same key; `/` stays `/`.
const norm = (path: string): string => (path === '/' ? '/' : path.replace(/\/+$/, ''));

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
			// A trailing slash denotes a directory; a file lookup must miss (matches Node).
			const node = nodes.get(path);
			if (node?.type !== 'file' || node.content === undefined) {
				throw new Error(`ENOENT: no such file: ${path}`);
			}
			return node.content;
		},
		isFile(path) {
			return nodes.get(path)?.type === 'file';
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
				if (node.type !== 'file' || !key.startsWith(prefix)) {
					continue;
				}
				const rel = key.slice(prefix.length);
				// Skip bundled deps, matching the contract and the Node implementation (no symlinks here).
				if (!rel.split('/').includes('node_modules')) {
					out.push(rel);
				}
			}
			return out;
		},
		realpath(path) {
			return path;
		},
	};
}
