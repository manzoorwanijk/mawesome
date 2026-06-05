import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Builds a `name → directory` index of the workspace packages, for resolving `workspace:`
 * (pnpm/yarn) dependencies by name. Walks up from `fromDir` to the workspace root
 * (`pnpm-workspace.yaml`, or a `package.json` with a `workspaces` field), expands its
 * package globs, and reads each package's name. Returns `undefined` if no workspace root
 * is found.
 */
export function buildWorkspaceIndex(fromDir: string): Map<string, string> | undefined {
	const found = findWorkspaceRoot(fromDir);
	if (found === undefined) {
		return undefined;
	}
	const index = new Map<string, string>();
	for (const dir of expandPackageGlobs(found.root, found.globs)) {
		const name = packageName(dir);
		if (name !== undefined && !index.has(name)) {
			index.set(name, dir);
		}
	}
	return index;
}

interface WorkspaceRoot {
	root: string;
	globs: string[];
}

/** Walks up for the nearest workspace root and its package globs. */
function findWorkspaceRoot(fromDir: string): WorkspaceRoot | undefined {
	let dir = resolve(fromDir);
	for (;;) {
		const pnpm = join(dir, 'pnpm-workspace.yaml');
		if (existsSync(pnpm)) {
			return { root: dir, globs: parsePnpmGlobs(readFileSync(pnpm, 'utf8')) };
		}
		const globs = npmWorkspaceGlobs(join(dir, 'package.json'));
		if (globs !== undefined) {
			return { root: dir, globs };
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

/** Reads `workspaces` (array, or `{ packages: [] }`) from a `package.json`. */
function npmWorkspaceGlobs(pkgPath: string): string[] | undefined {
	if (!existsSync(pkgPath)) {
		return undefined;
	}
	let parsed: { workspaces?: unknown };
	try {
		parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { workspaces?: unknown };
	} catch {
		return undefined;
	}
	const ws = parsed.workspaces;
	if (Array.isArray(ws)) {
		return ws.filter((g): g is string => typeof g === 'string');
	}
	if (
		ws !== null &&
		typeof ws === 'object' &&
		Array.isArray((ws as { packages?: unknown }).packages)
	) {
		return (ws as { packages: unknown[] }).packages.filter(
			(g): g is string => typeof g === 'string',
		);
	}
	return undefined;
}

/**
 * Minimal parse of `pnpm-workspace.yaml`'s `packages:` (block or flow `[a, b]` form),
 * skipping negations. YAML anchors/aliases are not supported (a documented limitation).
 */
function parsePnpmGlobs(yaml: string): string[] {
	const globs: string[] = [];
	const add = (raw: string): void => {
		const glob = raw
			.replace(/#.*$/, '')
			.trim()
			.replace(/^['"]|['"]$/g, '');
		if (glob !== '' && !glob.startsWith('!')) {
			globs.push(glob);
		}
	};

	let inPackages = false;
	for (const line of yaml.split('\n')) {
		const flow = /^packages:\s*\[(.*)\]\s*(?:#.*)?$/.exec(line);
		if (flow?.[1] !== undefined) {
			flow[1].split(',').forEach(add);
			continue;
		}
		if (/^packages:\s*(?:#.*)?$/.test(line)) {
			inPackages = true;
			continue;
		}
		if (!inPackages) {
			continue;
		}
		const item = /^\s+-\s+(.+?)\s*$/.exec(line);
		if (item?.[1] !== undefined) {
			add(item[1]);
		} else if (/^\S/.test(line)) {
			inPackages = false;
		}
	}
	return globs;
}

/** Expands package globs to absolute directories. Supports `path/*`, `path/**`, and exact. */
function expandPackageGlobs(root: string, globs: string[]): string[] {
	const dirs: string[] = [];
	for (const glob of globs) {
		if (glob.endsWith('/**')) {
			collectPackageDirs(join(root, glob.slice(0, -'/**'.length)), dirs);
		} else if (glob.endsWith('/*')) {
			for (const name of safeReaddir(join(root, glob.slice(0, -'/*'.length)))) {
				const dir = join(root, glob.slice(0, -'/*'.length), name);
				if (isDir(dir)) {
					dirs.push(dir);
				}
			}
		} else if (isDir(join(root, glob))) {
			dirs.push(join(root, glob));
		}
	}
	return dirs;
}

/** Recursively collects directories that contain a `package.json` (excluding node_modules). */
function collectPackageDirs(base: string, out: string[]): void {
	if (!isDir(base)) {
		return;
	}
	if (existsSync(join(base, 'package.json'))) {
		out.push(base);
	}
	for (const name of safeReaddir(base)) {
		const child = join(base, name);
		// Don't follow symlinks (avoids cycles / escaping the workspace).
		if (name !== 'node_modules' && !isSymlink(child) && isDir(child)) {
			collectPackageDirs(child, out);
		}
	}
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function packageName(dir: string): string | undefined {
	try {
		return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }).name;
	} catch {
		return undefined;
	}
}

function safeReaddir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
