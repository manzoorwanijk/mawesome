import { describe, expect, it } from 'vitest';
import { withRetry } from '../src/retry.ts';

/** A `sleep` that records each delay instead of waiting, for fast deterministic tests. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
	const delays: number[] = [];
	return {
		delays,
		sleep: (ms) => {
			delays.push(ms);
			return Promise.resolve();
		},
	};
}

const BASE = {
	retries: 3,
	baseDelayMs: 100,
	maxDelayMs: 2000,
	shouldRetry: () => true,
	// Jitter at its ceiling, so backoff is the deterministic exponential bound.
	random: () => 1,
};

describe('withRetry', () => {
	it('returns the first success without sleeping', async () => {
		const { sleep, delays } = recordingSleep();
		const result = await withRetry(() => Promise.resolve('ok'), { ...BASE, sleep });
		expect(result).toBe('ok');
		expect(delays).toEqual([]);
	});

	it('succeeds after K transient failures', async () => {
		const { sleep, delays } = recordingSleep();
		let calls = 0;
		const result = await withRetry(
			() => {
				calls++;
				return calls < 3 ? Promise.reject(new Error(`fail ${calls}`)) : Promise.resolve('ok');
			},
			{ ...BASE, sleep },
		);
		expect(result).toBe('ok');
		expect(calls).toBe(3);
		// Two failures → two backoffs, exponential from the base.
		expect(delays).toEqual([100, 200]);
	});

	it('exhausts the budget and rethrows the last error', async () => {
		const { sleep, delays } = recordingSleep();
		let calls = 0;
		await expect(
			withRetry(
				() => {
					calls++;
					return Promise.reject(new Error(`fail ${calls}`));
				},
				{ ...BASE, sleep },
			),
		).rejects.toThrow('fail 4');
		// 1 initial + 3 retries = 4 calls, 3 backoffs.
		expect(calls).toBe(4);
		expect(delays).toEqual([100, 200, 400]);
	});

	it('does not retry when shouldRetry rejects the error', async () => {
		const { sleep, delays } = recordingSleep();
		let calls = 0;
		await expect(
			withRetry(
				() => {
					calls++;
					return Promise.reject(new Error('fatal'));
				},
				{ ...BASE, sleep, shouldRetry: () => false },
			),
		).rejects.toThrow('fatal');
		expect(calls).toBe(1);
		expect(delays).toEqual([]);
	});

	it('caps the backoff at maxDelayMs', async () => {
		const { sleep, delays } = recordingSleep();
		let calls = 0;
		await expect(
			withRetry(() => Promise.reject(new Error(`fail ${++calls}`)), {
				...BASE,
				retries: 6,
				maxDelayMs: 250,
				sleep,
			}),
		).rejects.toThrow('fail 7');
		// 100, 200, then capped at 250 for the rest.
		expect(delays).toEqual([100, 200, 250, 250, 250, 250]);
	});

	it('scales the jittered delay by random()', async () => {
		const { sleep, delays } = recordingSleep();
		let calls = 0;
		await expect(
			withRetry(() => Promise.reject(new Error(`fail ${++calls}`)), {
				...BASE,
				// Half-jitter: each delay is half its exponential ceiling.
				random: () => 0.5,
				sleep,
			}),
		).rejects.toThrow('fail 4');
		expect(delays).toEqual([50, 100, 200]);
	});
});
