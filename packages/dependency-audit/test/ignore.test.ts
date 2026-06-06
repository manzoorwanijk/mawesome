import { describe, expect, it } from 'vitest';
import { matchesRule, parseIgnoreRules, partitionIgnored } from '../src/ignore.ts';
import type { Finding } from '../src/types.ts';

const finding = (over: Partial<Finding> = {}): Finding => ({
	specifier: 'react/jsx-runtime',
	packageName: 'react',
	surface: 'types',
	kind: 'undeclared',
	firstSeenIn: 'dist/index.d.ts',
	suggestion: '…',
	...over,
});

describe('matchesRule', () => {
	it('matches when every specified field equals the finding', () => {
		expect(matchesRule(finding(), { package: 'react' })).toBe(true);
		expect(matchesRule(finding(), { specifier: 'react/jsx-runtime' })).toBe(true);
		expect(matchesRule(finding(), { surface: 'types', kind: 'undeclared' })).toBe(true);
		expect(matchesRule(finding(), { package: 'react', surface: 'runtime' })).toBe(false);
		expect(matchesRule(finding(), { specifier: 'react' })).toBe(false);
	});

	it('never matches an empty rule (no accidental suppress-all)', () => {
		expect(matchesRule(finding(), {})).toBe(false);
	});
});

describe('partitionIgnored', () => {
	it('moves matched findings to ignored and keeps the rest visible', () => {
		const findings = [
			finding({ packageName: 'react' }),
			finding({ packageName: 'csstype', specifier: 'csstype', surface: 'runtime' }),
		];
		const { findings: visible, ignored } = partitionIgnored(findings, [{ package: 'react' }]);
		expect(visible.map((f) => f.packageName)).toEqual(['csstype']);
		expect(ignored.map((f) => f.packageName)).toEqual(['react']);
	});

	it('returns everything visible when there are no rules', () => {
		const findings = [finding()];
		expect(partitionIgnored(findings, []).ignored).toEqual([]);
	});
});

describe('parseIgnoreRules', () => {
	it('accepts well-formed rules and an absent value', () => {
		expect(parseIgnoreRules(undefined)).toEqual([]);
		expect(
			parseIgnoreRules([{ package: 'react' }, { surface: 'runtime', kind: 'unresolved' }]),
		).toEqual([{ package: 'react' }, { surface: 'runtime', kind: 'unresolved' }]);
	});

	it('rejects malformed rules instead of silently dropping them', () => {
		expect(() => parseIgnoreRules({})).toThrow(/must be an array/);
		expect(() => parseIgnoreRules(['react'])).toThrow(/must be an object/);
		expect(() => parseIgnoreRules([{ foo: 1 }])).toThrow(/at least one of/);
		expect(() => parseIgnoreRules([{ package: 42 }])).toThrow(/package must be a string/);
		expect(() => parseIgnoreRules([{ surface: 'css' }])).toThrow(/surface must be one of/);
	});
});
