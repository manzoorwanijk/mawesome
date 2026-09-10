import { isGitHubError } from '../github/errors.ts';
import type { Reporter, StatusPayload } from '../types.ts';

/** Attempts per logical status write, matching the transport's policy for reads. */
export const WRITE_ATTEMPTS = 3;

export interface WriteAttemptHooks {
	/** Runs before every physical attempt; returning false abandons the write without an error. */
	before(attempt: number): Promise<boolean>;
	sleep(ms: number): Promise<void>;
	retryBaseMs: number;
}

/** Whether a failure is worth another attempt: server errors and network failures only. */
export function isTransient(error: unknown): boolean {
	return isGitHubError(error, 'server') || isGitHubError(error, 'network');
}

/**
 * Writes a status with budget-aware retries.
 * The transport does not retry status writes itself, so every physical request passes through `before`.
 */
export async function writeWithRetries(
	reporter: Reporter,
	sha: string,
	status: StatusPayload,
	hooks: WriteAttemptHooks,
): Promise<'written' | 'abandoned'> {
	for (let attempt = 1; ; attempt++) {
		if (!(await hooks.before(attempt))) {
			return 'abandoned';
		}
		try {
			await reporter.write(sha, status);
			return 'written';
		} catch (error) {
			if (!isTransient(error) || attempt >= WRITE_ATTEMPTS) {
				throw error;
			}
			await hooks.sleep(hooks.retryBaseMs * attempt ** 2);
		}
	}
}
