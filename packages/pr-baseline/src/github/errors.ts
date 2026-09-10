export type FailureKind =
	| 'rate-limit'
	| 'auth'
	| 'permission'
	| 'not-found'
	| 'conflict'
	| 'status-cap'
	| 'validation'
	| 'server'
	| 'network'
	| 'other';

/** A failed GitHub request, classified so callers can decide whether to stop, retry or skip. */
export class GitHubError extends Error {
	override name = 'GitHubError';
	readonly kind: FailureKind;
	readonly status: number | undefined;
	readonly path: string;
	readonly body: string;
	readonly retryAfterMs: number | undefined;

	constructor(
		kind: FailureKind,
		path: string,
		message: string,
		details: { status?: number; body?: string; retryAfterMs?: number; cause?: unknown } = {},
	) {
		super(message, details.cause === undefined ? undefined : { cause: details.cause });
		this.kind = kind;
		this.path = path;
		this.status = details.status;
		this.body = details.body ?? '';
		this.retryAfterMs = details.retryAfterMs;
	}
}

export function isGitHubError(error: unknown, kind?: FailureKind): error is GitHubError {
	return error instanceof GitHubError && (kind === undefined || error.kind === kind);
}

type HeaderSource = { get(name: string): string | null };

/**
 * Classifies a non-2xx response.
 * A secondary limit can arrive with neither header set, leaving the body as the only signal.
 */
export function classifyFailure(status: number, headers: HeaderSource, body: string): FailureKind {
	if (status === 403 || status === 429) {
		if (
			headers.get('x-ratelimit-remaining') === '0' ||
			headers.get('retry-after') !== null ||
			/rate limit/i.test(body)
		) {
			return 'rate-limit';
		}
		return 'permission';
	}
	if (status === 401) {
		return 'auth';
	}
	if (status === 404) {
		return 'not-found';
	}
	if (status === 409) {
		return 'conflict';
	}
	if (status === 422) {
		return /maximum number of statuses/i.test(body) ? 'status-cap' : 'validation';
	}
	if (status >= 500 && status <= 599) {
		return 'server';
	}
	return 'other';
}

/** Parses `retry-after` (seconds) into milliseconds, if present. */
export function retryAfterMs(headers: HeaderSource): number | undefined {
	const value = headers.get('retry-after');
	if (value === null) {
		return undefined;
	}
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/** Retry guidance for an operator, shared by every command summary. */
export const RETRY_HINT = 'Retry later by dispatching the workflow or running the command again.';
