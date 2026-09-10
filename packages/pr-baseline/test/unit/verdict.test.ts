import { describe, expect, it } from 'vitest';
import { DEFAULT_DESCRIPTIONS, repoUrl } from '../../src/config.ts';
import {
	boundDescription,
	computeVerdict,
	MAX_DESCRIPTION_LENGTH,
	misconfiguredVerdict,
	notApplicableVerdict,
	compareStatus,
	renderDescription,
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

	it('links a failure to the compare view of the base branch unless a target URL is set', () => {
		const answers = [
			{ name: 'one', sha: 'x', applicable: true, contains: true },
			{ name: 'two', sha: 'y', applicable: true, contains: false },
			{ name: 'three', sha: 'z', applicable: true, contains: false },
		];
		const linked: VerdictContext = {
			...context,
			targetUrl: undefined,
			repoUrl: 'https://github.com/acme/widgets',
		};
		expect(computeVerdict(answers, linked, 'h').status.targetUrl).toBe(
			'https://github.com/acme/widgets/compare/h...main',
		);
		expect(computeVerdict(answers, context, 'h').status.targetUrl).toBe(
			'https://example.test/help',
		);
		expect(computeVerdict(answers, linked).status.targetUrl).toBeUndefined();
		expect(
			computeVerdict(answers, { ...context, targetUrl: undefined }, 'h').status.targetUrl,
		).toBeUndefined();
		const pass = computeVerdict(
			[{ name: 'one', sha: 'x', applicable: true, contains: true }],
			linked,
			'h',
		);
		expect(pass.status.targetUrl).toBeUndefined();
	});

	it('generates the same link for two different baseline SHAs on one head and base', () => {
		const linked: VerdictContext = {
			...context,
			targetUrl: undefined,
			repoUrl: 'https://github.com/acme/widgets',
		};
		const link = (sha: string) =>
			computeVerdict([{ name: 'one', sha, applicable: true, contains: false }], linked, 'h').status
				.targetUrl;
		expect(link('aaa')).toBe(link('bbb'));
	});

	it('escapes a base branch name that would otherwise truncate the URL', () => {
		const linked: VerdictContext = {
			...context,
			base: 'release/1.x#2',
			targetUrl: undefined,
			repoUrl: 'https://github.com/acme/widgets',
		};
		expect(
			computeVerdict([{ name: 'one', sha: 'x', applicable: true, contains: false }], linked, 'h')
				.status.targetUrl,
		).toBe('https://github.com/acme/widgets/compare/h...release%2F1.x%232');
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

	it('leaves every pass unlinked without a target URL, whatever the server', () => {
		const ghes: VerdictContext = {
			...context,
			targetUrl: undefined,
			repoUrl: repoUrl({ serverUrl: 'https://ghe.test/', repo: 'acme/widgets' }),
		};
		const missing = { name: 'one', sha: 'x', applicable: true, contains: false };
		expect(computeVerdict([missing], ghes, 'h').status.targetUrl).toBe(
			'https://ghe.test/acme/widgets/compare/h...main',
		);
		expect(
			computeVerdict([{ ...missing, contains: true }], ghes, 'h').status.targetUrl,
		).toBeUndefined();
		expect(notApplicableVerdict(ghes).status.targetUrl).toBeUndefined();
		expect(misconfiguredVerdict(['one'], ghes).status.targetUrl).toBeUndefined();
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

describe('compareStatus', () => {
	const intended = { state: 'success' as const, description: 'ok', targetUrl: undefined };
	const current = {
		state: 'success' as const,
		description: 'ok',
		targetUrl: null,
		creator: 'bot',
	};

	it('reports no difference when state, description, target URL and creator all match', () => {
		expect(compareStatus(current, intended, 'bot')).toBe('current');
	});

	it('calls a state or creator difference material, an absent status included', () => {
		expect(compareStatus({ ...current, state: 'failure' }, intended, 'bot')).toBe('material');
		expect(compareStatus(current, intended, 'someone-else')).toBe('material');
		expect(compareStatus({ ...current, creator: null }, intended, 'bot')).toBe('material');
		expect(compareStatus(null, intended, 'bot')).toBe('material');
	});

	it('calls a description or target URL difference cosmetic', () => {
		expect(compareStatus({ ...current, description: 'other' }, intended, 'bot')).toBe('cosmetic');
		expect(compareStatus({ ...current, targetUrl: 'https://x' }, intended, 'bot')).toBe('cosmetic');
	});
});
