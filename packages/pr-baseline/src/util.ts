export function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isFullSha(value: string): boolean {
	return /^[0-9a-f]{40}$/i.test(value);
}

export function shortSha(sha: string): string {
	return sha.slice(0, 12);
}

/** A repository state problem, as opposed to a configuration or API failure; exit code 2. */
export class BaselineError extends Error {
	override name = 'BaselineError';
}

/** Writes and milliseconds that must both pass before another progress line; a 450-write run then logs about nine. */
const PROGRESS_WRITES = 50;
const PROGRESS_MS = 30_000;

export interface ProgressThrottle {
	/** Whether a progress line is due, recording the emission when it is. */
	due(written: number, at: number): boolean;
}

/**
 * Rate-limits progress lines to one per 50 writes and 30 seconds, whichever is slower.
 * Both thresholds, so a fast run does not narrate every batch and a slow one still says it is alive.
 */
export function createProgressThrottle(startedAt: number): ProgressThrottle {
	let lastWrites = 0;
	let lastAt = startedAt;
	return {
		due(written: number, at: number): boolean {
			if (written - lastWrites < PROGRESS_WRITES || at - lastAt < PROGRESS_MS) {
				return false;
			}
			lastWrites = written;
			lastAt = at;
			return true;
		},
	};
}

/** Whether two ref snapshots name the same baselines at the same commits; order does not matter. */
export function sameRefs(
	before: ReadonlyArray<{ name: string; sha: string | null }>,
	after: ReadonlyArray<{ name: string; sha: string | null }>,
): boolean {
	if (before.length !== after.length) {
		return false;
	}
	const later = new Map(after.map((entry) => [entry.name, entry.sha]));
	return before.every((entry) => later.has(entry.name) && later.get(entry.name) === entry.sha);
}

/** Every baseline as `{ name, sha }`, absent ones included, for adapters that verify them against their own view. */
export function refSnapshot(
	baselines: ReadonlyArray<{ name: string; sha: string | null }>,
): Array<{ name: string; sha: string | null }> {
	return baselines.map((baseline) => ({ name: baseline.name, sha: baseline.sha }));
}
