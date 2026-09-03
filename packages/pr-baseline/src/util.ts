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
