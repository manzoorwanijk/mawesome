import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFileSystem } from '../src/fs-node.ts';

/*
 * These exercise the real Node filesystem (not the in-memory port), because the behavior under test
 * is symlink handling — a package's `node_modules` links into a shared, cyclic store (pnpm's
 * `.store`). A naive `readdirSync(recursive: true)` follows those links and walks the whole graph,
 * exhausting the heap; `readdirRecursive` must not.
 */
const temps: string[] = [];
afterEach(() => {
	for (const dir of temps.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempTree(): string {
	const root = mkdtempSync(join(tmpdir(), 'da-fsnode-'));
	temps.push(root);
	return root;
}

describe('nodeFileSystem.readdirRecursive', () => {
	it('returns regular files recursively, relative to the root', () => {
		const root = tempTree();
		mkdirSync(join(root, 'src', 'sub'), { recursive: true });
		writeFileSync(join(root, 'index.js'), '');
		writeFileSync(join(root, 'src', 'a.js'), '');
		writeFileSync(join(root, 'src', 'sub', 'b.d.ts'), '');

		expect(nodeFileSystem.readdirRecursive(root).toSorted()).toEqual([
			'index.js',
			join('src', 'a.js'),
			join('src', 'sub', 'b.d.ts'),
		]);
	});

	it('excludes node_modules (top-level and nested) but keeps lookalike names', () => {
		const root = tempTree();
		writeFileSync(join(root, 'index.js'), '');
		mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
		writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), '');
		mkdirSync(join(root, 'src', 'node_modules'), { recursive: true });
		writeFileSync(join(root, 'src', 'node_modules', 'nested.js'), '');
		// A directory merely *named* like node_modules is a real source dir, not a bundled dep.
		mkdirSync(join(root, 'node_modules-foo'), { recursive: true });
		writeFileSync(join(root, 'node_modules-foo', 'keep.js'), '');

		expect(nodeFileSystem.readdirRecursive(root).toSorted()).toEqual([
			'index.js',
			join('node_modules-foo', 'keep.js'),
		]);
	});

	it('does not follow directory symlinks, so a cyclic store cannot explode the walk', () => {
		const root = tempTree();
		writeFileSync(join(root, 'index.js'), '');
		mkdirSync(join(root, 'node_modules'), { recursive: true });
		// A self-referential link inside node_modules (as a workspace's store links would form a cycle).
		symlinkSync(root, join(root, 'node_modules', 'self'), 'dir');
		// And a top-level directory symlink pointing back at the root.
		symlinkSync(root, join(root, 'loop'), 'dir');

		// Terminates (no infinite traversal) and never descends a symlink — only the real file.
		expect(nodeFileSystem.readdirRecursive(root)).toEqual(['index.js']);
	});

	it('skips a symlinked regular file (only real files are part of a package surface)', () => {
		const root = tempTree();
		writeFileSync(join(root, 'real.js'), '');
		symlinkSync(join(root, 'real.js'), join(root, 'link.js'), 'file');

		expect(nodeFileSystem.readdirRecursive(root)).toEqual(['real.js']);
	});

	it('returns [] for a missing directory', () => {
		expect(nodeFileSystem.readdirRecursive(join(tempTree(), 'nope'))).toEqual([]);
	});
});
