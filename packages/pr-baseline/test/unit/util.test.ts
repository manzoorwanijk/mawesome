import { describe, expect, it } from 'vitest';
import { createProgressThrottle, sameRefs } from '../../src/util.ts';

describe('createProgressThrottle', () => {
	it('emits only once both the write and the time threshold have passed', () => {
		const throttle = createProgressThrottle(1_000);
		expect(throttle.due(49, 1_000_000)).toBe(false);
		// Enough time, not enough writes.
		expect(throttle.due(50, 1_500)).toBe(false);
		// Enough writes, not enough time.
		expect(throttle.due(50, 31_000)).toBe(true);
		// The next line needs another 50 writes and another 30 seconds.
		expect(throttle.due(99, 999_000)).toBe(false);
		expect(throttle.due(100, 61_000)).toBe(true);
	});
});

describe('sameRefs', () => {
	const refs = [
		{ name: 'a', sha: '1' },
		{ name: 'b', sha: null },
	];

	it('compares by name, not by position', () => {
		expect(sameRefs(refs, [refs[1] as never, refs[0] as never])).toBe(true);
		expect(
			sameRefs(refs, [
				{ name: 'a', sha: '1' },
				{ name: 'b', sha: '2' },
			]),
		).toBe(false);
		expect(
			sameRefs(refs, [
				{ name: 'a', sha: '1' },
				{ name: 'c', sha: null },
			]),
		).toBe(false);
		expect(sameRefs(refs, [{ name: 'a', sha: '1' }])).toBe(false);
	});
});
