import { describe, expect, it } from 'vitest';
import { createMemoryFileSystem } from '../src/fs.ts';
import { expandPatternTarget } from '../src/fsutil.ts';

describe('expandPatternTarget', () => {
	const fs = createMemoryFileSystem();
	for (const path of [
		'/pkg/dist/a.js',
		'/pkg/dist/b.js',
		'/pkg/dist/sub/c.js',
		'/pkg/dist/d.d.ts',
		'/pkg/other.js',
	]) {
		fs.writeFile(path, '');
	}

	it('expands a single-star target against matching files (`*` spans `/`)', () => {
		expect(expandPatternTarget(fs, '/pkg', './dist/*.js').sort()).toEqual([
			'./dist/a.js',
			'./dist/b.js',
			'./dist/sub/c.js',
		]);
	});

	it('respects prefix and suffix, excluding non-matching files', () => {
		expect(expandPatternTarget(fs, '/pkg', './dist/*.d.ts')).toEqual(['./dist/d.d.ts']);
	});

	it('returns the target unchanged when it has no star', () => {
		expect(expandPatternTarget(fs, '/pkg', './dist/a.js')).toEqual(['./dist/a.js']);
	});

	it('does not expand a malformed multi-star target', () => {
		expect(expandPatternTarget(fs, '/pkg', './dist/*/*.js')).toEqual([]);
	});
});
