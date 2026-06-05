import { describe, expect, it } from 'vitest';
import { mapLimit } from '../src/concurrency.ts';

describe('mapLimit', () => {
	it('preserves input order regardless of completion order', async () => {
		const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
			await new Promise((r) => setTimeout(r, n));
			return n * 10;
		});
		expect(out).toEqual([50, 10, 40, 20, 30]);
	});

	it('never runs more than `limit` tasks at once', async () => {
		let active = 0;
		let peak = 0;
		await mapLimit(
			Array.from({ length: 20 }, (_, i) => i),
			3,
			async () => {
				active += 1;
				peak = Math.max(peak, active);
				await new Promise((r) => setTimeout(r, 3));
				active -= 1;
			},
		);
		expect(peak).toBeLessThanOrEqual(3);
	});

	it('handles an empty input', async () => {
		expect(await mapLimit([], 4, async (x) => x)).toEqual([]);
	});
});
