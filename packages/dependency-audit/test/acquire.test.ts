import { describe, expect, it } from 'vitest';
import { looksLikeSpec } from '../src/acquire.ts';

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

	it('treats any .tgz/.tar.gz path as a local tarball, not a registry spec', () => {
		// A missing bare `foo.tgz` must error as a not-found path, not 404 from the registry.
		for (const path of ['foo.tgz', 'dir/foo.tgz', 'pkg.tar.gz']) {
			expect(looksLikeSpec(path)).toBe(false);
		}
	});
});
