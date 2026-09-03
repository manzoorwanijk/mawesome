import { describe, expect, it } from 'vitest';
import { supportsNoLazyFetch } from '../../src/git/repo.ts';

describe('supportsNoLazyFetch', () => {
	it('accepts 2.45 and newer, rejects older and unparsable output', () => {
		expect(supportsNoLazyFetch('git version 2.45.0')).toBe(true);
		expect(supportsNoLazyFetch('git version 2.50.1 (Apple Git-155)')).toBe(true);
		expect(supportsNoLazyFetch('git version 3.0.0')).toBe(true);
		expect(supportsNoLazyFetch('git version 2.44.3')).toBe(false);
		expect(supportsNoLazyFetch('git version 2.9')).toBe(false);
		expect(supportsNoLazyFetch('nonsense')).toBe(false);
	});
});

describe('chunks', () => {
	it('bounds batches by count and by total length', async () => {
		const { chunks } = await import('../../src/git/repo.ts');
		const short = Array.from({ length: 450 }, (_, index) => `r${index}`);
		expect(chunks(short).map((batch) => batch.length)).toEqual([200, 200, 50]);
		const long = Array.from({ length: 10 }, (_, index) => `refs/tags/${'x'.repeat(1000)}${index}`);
		const batches = chunks(long);
		expect(batches.length).toBeGreaterThan(1);
		for (const batch of batches) {
			expect(batch.join(' ').length).toBeLessThanOrEqual(6000);
		}
		expect(batches.flat()).toEqual(long);
	});
});

describe('chunks with an oversized argument', () => {
	it('refuses one argument that alone exceeds the bound', async () => {
		const { chunks } = await import('../../src/git/repo.ts');
		expect(() => chunks(['x'.repeat(7000)])).toThrow(/exceeds the command-line budget/);
	});
});
