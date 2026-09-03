import { describe, expect, it } from 'vitest';
import { classifyFailure, retryAfterMs } from '../../src/github/errors.ts';

function headers(entries: Record<string, string> = {}): Headers {
	return new Headers(entries);
}

describe('classifyFailure', () => {
	it('detects a primary limit by the remaining header', () => {
		expect(classifyFailure(403, headers({ 'x-ratelimit-remaining': '0' }), '')).toBe('rate-limit');
	});

	it('detects a secondary limit by retry-after or the body alone', () => {
		expect(classifyFailure(403, headers({ 'retry-after': '60' }), '')).toBe('rate-limit');
		expect(
			classifyFailure(429, headers(), '{"message":"You have exceeded a secondary rate limit"}'),
		).toBe('rate-limit');
	});

	it('keeps an ordinary 403 a permission error', () => {
		expect(
			classifyFailure(
				403,
				headers({ 'x-ratelimit-remaining': '900' }),
				'{"message":"Resource not accessible by integration"}',
			),
		).toBe('permission');
	});

	it('separates the status cap from other validation errors', () => {
		expect(
			classifyFailure(
				422,
				headers(),
				'This SHA and context has reached the maximum number of statuses.',
			),
		).toBe('status-cap');
		expect(classifyFailure(422, headers(), 'Update is not a fast forward')).toBe('validation');
	});

	it('maps the remaining codes', () => {
		expect(classifyFailure(401, headers(), '')).toBe('auth');
		expect(classifyFailure(404, headers(), '')).toBe('not-found');
		expect(classifyFailure(409, headers(), '')).toBe('conflict');
		expect(classifyFailure(502, headers(), '')).toBe('server');
		expect(classifyFailure(504, headers(), '')).toBe('server');
		expect(classifyFailure(500, headers(), '')).toBe('server');
	});
});

describe('retryAfterMs', () => {
	it('parses seconds and ignores garbage', () => {
		expect(retryAfterMs(headers({ 'retry-after': '30' }))).toBe(30_000);
		expect(retryAfterMs(headers({ 'retry-after': 'soon' }))).toBeUndefined();
		expect(retryAfterMs(headers())).toBeUndefined();
	});
});
