import { describe, expect, it } from 'vitest';
import { DEFAULT_DESCRIPTIONS } from '../../src/config.ts';
import {
	boundDescription,
	computeVerdict,
	MAX_DESCRIPTION_LENGTH,
	misconfiguredVerdict,
	notApplicableVerdict,
	renderDescription,
	statusMatches,
	type VerdictContext,
} from '../../src/verdict.ts';

const context: VerdictContext = {
	base: 'main',
	descriptions: DEFAULT_DESCRIPTIONS,
	targetUrl: 'https://example.test/help',
};

describe('computeVerdict', () => {
	it('passes when every applicable baseline is contained', () => {
		const verdict = computeVerdict(
			[
				{ name: 'a', sha: 'x', applicable: true, contains: true },
				{ name: 'b', sha: 'y', applicable: true, contains: true },
			],
			context,
		);
		expect(verdict.kind).toBe('pass');
		expect(verdict.status).toEqual({
			state: 'success',
			description: 'Contains the required main changes.',
			targetUrl: 'https://example.test/help',
		});
		expect(verdict.applicable).toEqual(['a', 'b']);
	});

	it('treats an absent baseline as satisfied', () => {
		const verdict = computeVerdict(
			[{ name: 'a', sha: null, applicable: true, contains: null }],
			context,
		);
		expect(verdict.kind).toBe('pass');
		expect(verdict.missing).toEqual([]);
	});

	it('ignores baselines that do not apply', () => {
		const verdict = computeVerdict(
			[
				{ name: 'a', sha: 'x', applicable: true, contains: true },
				{ name: 'b', sha: 'y', applicable: false, contains: null },
			],
			context,
		);
		expect(verdict.kind).toBe('pass');
		expect(verdict.applicable).toEqual(['a']);
	});

	it('fails naming the missing baselines, listing two and counting the rest', () => {
		const verdict = computeVerdict(
			[
				{ name: 'one', sha: 'x', applicable: true, contains: false },
				{ name: 'two', sha: 'y', applicable: true, contains: true },
				{ name: 'three', sha: 'z', applicable: true, contains: false },
				{ name: 'four', sha: 'w', applicable: true, contains: false },
			],
			context,
		);
		expect(verdict.kind).toBe('fail');
		expect(verdict.missing).toEqual(['one', 'three', 'four']);
		expect(verdict.status.state).toBe('failure');
		expect(verdict.status.description).toBe(
			'Merge or rebase main to include: one, three and 1 more',
		);
	});

	it('renders the not-applicable and misconfigured passes', () => {
		expect(notApplicableVerdict(context).status).toEqual({
			state: 'success',
			description: 'Baseline applies to main only.',
			targetUrl: 'https://example.test/help',
		});
		const bad = misconfiguredVerdict(['stale'], context);
		expect(bad.kind).toBe('misconfigured');
		expect(bad.status.state).toBe('success');
		expect(bad.status.description).toContain('stale not on main');
	});
});

describe('renderDescription', () => {
	it('bounds a long custom template deterministically', () => {
		const template = `${'x'.repeat(200)} {baselines}`;
		const rendered = renderDescription(template, { base: 'main', baselines: ['t'] });
		expect(Array.from(rendered)).toHaveLength(MAX_DESCRIPTION_LENGTH);
		expect(rendered.endsWith('…')).toBe(true);
		expect(renderDescription(template, { base: 'main', baselines: ['t'] })).toBe(rendered);
	});

	it('bounds long baseline names', () => {
		const baselines = ['a'.repeat(100), 'b'.repeat(100)];
		const rendered = renderDescription(DEFAULT_DESCRIPTIONS.fail, { base: 'main', baselines });
		expect(Array.from(rendered)).toHaveLength(MAX_DESCRIPTION_LENGTH);
	});

	it('counts multibyte text by code points', () => {
		const text = '🙂'.repeat(150);
		const bounded = boundDescription(text);
		expect(Array.from(bounded)).toHaveLength(MAX_DESCRIPTION_LENGTH);
		expect(bounded.endsWith('…')).toBe(true);
		expect(boundDescription('🙂'.repeat(140))).toBe('🙂'.repeat(140));
	});
});

describe('statusMatches', () => {
	const intended = { state: 'success' as const, description: 'ok', targetUrl: undefined };

	it('requires state, description, target URL and creator to match', () => {
		const current = {
			state: 'success' as const,
			description: 'ok',
			targetUrl: null,
			creator: 'bot',
		};
		expect(statusMatches(current, intended, 'bot')).toBe(true);
		expect(statusMatches({ ...current, state: 'failure' }, intended, 'bot')).toBe(false);
		expect(statusMatches({ ...current, description: 'other' }, intended, 'bot')).toBe(false);
		expect(statusMatches({ ...current, targetUrl: 'https://x' }, intended, 'bot')).toBe(false);
		expect(statusMatches(current, intended, 'someone-else')).toBe(false);
		expect(statusMatches(null, intended, 'bot')).toBe(false);
	});
});
