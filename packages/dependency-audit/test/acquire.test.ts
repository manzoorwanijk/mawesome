import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { acquire, looksLikeSpec, SkippedTargetError } from '../src/acquire.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');

describe('looksLikeSpec', () => {
	it('treats bare names, versioned, and scoped specs as specs', () => {
		for (const spec of ['react', 'react@18.3.1', 'react@latest', '@types/react@18', '@scope/x']) {
			expect(looksLikeSpec(spec)).toBe(true);
		}
	});

	it('treats http(s) URLs as specs', () => {
		expect(looksLikeSpec('https://registry.npmjs.org/x/-/x-1.0.0.tgz')).toBe(true);
		expect(looksLikeSpec('http://example.com/x.tgz')).toBe(true);
	});

	it('treats filesystem paths as non-specs', () => {
		for (const path of ['./pkg', '../pkg', '/abs/pkg', '.', './x.tgz', 'C:\\pkg', 'C:x']) {
			expect(looksLikeSpec(path)).toBe(false);
		}
	});

	it('treats a bare slashed path (no @scope) as a path, not a user/repo shorthand', () => {
		for (const path of ['packages/foo', 'a/b/c']) {
			expect(looksLikeSpec(path)).toBe(false);
		}
		// Scoped specs keep their slash and stay specs.
		expect(looksLikeSpec('@scope/x')).toBe(true);
		expect(looksLikeSpec('@types/react@18')).toBe(true);
	});

	it('treats any .tgz/.tar.gz path as a local tarball, not a registry spec', () => {
		// A missing bare `foo.tgz` must error as a not-found path, not 404 from the registry.
		for (const path of ['foo.tgz', 'dir/foo.tgz', 'pkg.tar.gz']) {
			expect(looksLikeSpec(path)).toBe(false);
		}
	});
});

describe('acquire (skip vs error)', () => {
	it('skips a local path that exists but is not a package (e.g. a stray .md match)', async () => {
		await expect(acquire(join(fixtures, 'not-a-package.md'))).rejects.toBeInstanceOf(
			SkippedTargetError,
		);
	});

	it('skips a directory with no package.json', async () => {
		// `fixtures/deps` exists but has no package.json of its own.
		await expect(acquire(join(fixtures, 'deps'))).rejects.toBeInstanceOf(SkippedTargetError);
	});

	it('errors (does not skip) a path that does not exist at all', async () => {
		const err = await acquire(join(fixtures, '__missing__')).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(SkippedTargetError);
	});
});
