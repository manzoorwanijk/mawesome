/** Tuning for {@link withRetry}. */
export interface RetryOptions {
	/** Extra attempts after the first (so `retries: 3` means up to 4 calls total). */
	retries: number;
	/** Backoff for the first retry, in ms; doubles each attempt up to {@link RetryOptions.maxDelayMs}. */
	baseDelayMs: number;
	/** Upper bound on a single backoff, in ms. */
	maxDelayMs: number;
	/** `true` if `error` is worth retrying; a `false` aborts immediately (e.g. a bomb guard). */
	shouldRetry(error: unknown): boolean;
	/** Sleep seam — overridden in tests to avoid real delays and to record them. */
	sleep?: (ms: number) => Promise<void>;
	/** Jitter source in `[0, 1]`; defaults to `Math.random` (`[0, 1)`). Overridden in tests for determinism. */
	random?: () => number;
}

/**
 * Runs `fn`, retrying a transient failure with exponential backoff + full jitter, up to
 * `retries` extra attempts. Re-throws the last error once attempts are exhausted, or
 * immediately when `shouldRetry` rejects it. Bounds registry/cache/extract races without
 * masking a genuine, repeatable failure.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
	const { retries, baseDelayMs, maxDelayMs, shouldRetry } = options;
	const sleep = options.sleep ?? defaultSleep;
	const random = options.random ?? Math.random;
	let attempt = 0;
	for (;;) {
		try {
			// oxlint-disable-next-line no-await-in-loop
			return await fn();
		} catch (error) {
			if (attempt >= retries || !shouldRetry(error)) {
				throw error;
			}
			// Full jitter: a random point in [0, the capped exponential backoff].
			const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
			// oxlint-disable-next-line no-await-in-loop
			await sleep(random() * ceiling);
			attempt++;
		}
	}
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((settle) => setTimeout(settle, ms));
}
