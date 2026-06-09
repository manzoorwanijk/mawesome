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

	describe('scoped rules (target/path)', () => {
		const ctx = { name: 'my-pkg', target: './packages/my-pkg' };

		it('matches target by package name or by the target spec', () => {
			expect(matchesRule(finding(), { target: 'my-pkg' }, ctx)).toBe(true);
			expect(matchesRule(finding(), { target: './packages/my-pkg' }, ctx)).toBe(true);
			expect(matchesRule(finding(), { target: 'other-pkg' }, ctx)).toBe(false);
		});

		it('matches the target spec in its tarball and registry forms', () => {
			expect(
				matchesRule(finding(), { target: '/abs/path/pkg' }, { name: 'p', target: '/abs/path/pkg' }),
			).toBe(true);
			expect(
				matchesRule(finding(), { target: './my-pkg.tgz' }, { name: 'p', target: './my-pkg.tgz' }),
			).toBe(true);
			expect(
				matchesRule(finding(), { target: 'react@18' }, { name: 'react', target: 'react@18' }),
			).toBe(true);
			// Exact-equality, not path-normalized: a different spelling of the same dir does not match.
			expect(matchesRule(finding(), { target: 'packages/my-pkg' }, ctx)).toBe(false);
		});

		it('never matches a target rule without a context', () => {
			// `target` needs the run context; `path` is finding-intrinsic and matches without it.
			expect(matchesRule(finding(), { target: 'my-pkg' })).toBe(false);
			expect(matchesRule(finding({ firstSeenIn: 'a.d.ts' }), { path: '**' })).toBe(true);
		});

		it('matches an unnamed target only by its spec', () => {
			const unnamed = { name: undefined, target: './pkg' };
			expect(matchesRule(finding(), { target: './pkg' }, unnamed)).toBe(true);
			expect(matchesRule(finding(), { target: 'my-pkg' }, unnamed)).toBe(false);
		});

		// Each row globs `path` against `firstSeenIn`; the comment states the rule exercised.
		it.each([
			// `*` matches within one segment; `**` (whole segment) is a globstar.
			['fixtures/deep/x.d.ts', 'fixtures/**', true],
			['fixtures/deep/x.d.ts', 'fixtures/*/x.d.ts', true],
			['fixtures/deep/x.d.ts', '*.d.ts', false], // `*` does not cross `/`
			['fixtures/deep/x.d.ts', 'src/**', false],
			// Leading `**/` matches zero or more segments, including the root.
			['x.d.ts', '**/x.d.ts', true],
			['a/b/x.d.ts', '**/x.d.ts', true],
			// Inner `**/` spans any depth (including zero).
			['a/b/c/x.d.ts', 'a/**/x.d.ts', true],
			['a/x.d.ts', 'a/**/x.d.ts', true],
			// Trailing `/**` matches descendants but not the directory itself.
			['fixtures', 'fixtures/**', false],
			['fixtures/x', 'fixtures/**', true],
			// A non-segment `**` degrades to a single-segment `*` (never crosses `/`).
			['aXXb/x.d.ts', 'a**b/*.d.ts', true],
			['a/b/x.d.ts', 'a**b/*.d.ts', false],
			// A bare `**` matches everything; an empty glob matches only the empty path.
			['any/where.d.ts', '**', true],
			['', '', true],
			['x', '', false],
			// `?` is exactly one non-`/` character.
			['a/b.ts', 'a/?.ts', true],
			['a/bc.ts', 'a/?.ts', false],
			['a/.ts', 'a/?.ts', false],
			// Regex metacharacters (incl. a bracket class) are literal outside `**`/`*`/`?`.
			['a.b+(c)/x.d.ts', 'a.b+(c)/*.d.ts', true],
			['aXbc/x.d.ts', 'a.b+(c)/*.d.ts', false],
			['[abc]/x.ts', '[abc]/*.ts', true],
			['a/x.ts', '[abc]/*.ts', false],
			// A long star run collapses to one atom — no catastrophic backtracking.
			[`${'x'.repeat(64)}.ts`, `${'*'.repeat(40)}z`, false],
			[`${'x'.repeat(64)}.ts`, `${'*'.repeat(40)}.ts`, true],
		] as const)('globs %j with %j → %s', (firstSeenIn, path, expected) => {
			expect(matchesRule(finding({ firstSeenIn }), { path }, ctx)).toBe(expected);
		});

		it('combines path with a surface filter', () => {
			const f = finding({ surface: 'runtime', firstSeenIn: 'fixtures/x.js' });
			expect(matchesRule(f, { path: 'fixtures/**', surface: 'runtime' }, ctx)).toBe(true);
			expect(matchesRule(f, { path: 'fixtures/**', surface: 'types' }, ctx)).toBe(false);
		});

		it('requires every field (scope + finding) to match', () => {
			const f = finding({ packageName: 'react', firstSeenIn: 'fixtures/x.d.ts' });
			expect(matchesRule(f, { target: 'my-pkg', path: 'fixtures/**', package: 'react' }, ctx)).toBe(
				true,
			);
			expect(matchesRule(f, { target: 'my-pkg', path: 'src/**', package: 'react' }, ctx)).toBe(
				false,
			);
		});
	});
});

describe('partitionIgnored with a context', () => {
	it('a target-scoped rule suppresses only in its own target', () => {
		const f = finding({ firstSeenIn: 'fixtures/x.d.ts' });
		const rules = [{ target: 'my-pkg', path: 'fixtures/**' }];
		// Fires in the named package…
		expect(partitionIgnored([f], rules, { name: 'my-pkg', target: './my-pkg' }).ignored).toEqual([
			f,
		]);
		// …but the same specifier in a different package stays visible (precise, not global).
		expect(
			partitionIgnored([f], rules, { name: 'other-pkg', target: './other-pkg' }).findings,
		).toEqual([f]);
	});

	it('without a context, a target rule is inert but a path rule still applies', () => {
		const f = finding({ firstSeenIn: 'fixtures/x.d.ts' });
		expect(partitionIgnored([f], [{ target: 'my-pkg' }]).findings).toEqual([f]);
		expect(partitionIgnored([f], [{ path: 'fixtures/**' }]).ignored).toEqual([f]);
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

	it('accepts the scoping fields', () => {
		expect(parseIgnoreRules([{ target: 'my-pkg', path: 'fixtures/**' }])).toEqual([
			{ target: 'my-pkg', path: 'fixtures/**' },
		]);
		expect(() => parseIgnoreRules([{ target: 1 }])).toThrow(/target must be a string/);
		expect(() => parseIgnoreRules([{ path: 1 }])).toThrow(/path must be a string/);
	});

	it('accepts empty-string scoping fields (consistent with the other string fields)', () => {
		expect(parseIgnoreRules([{ target: '', path: '' }])).toEqual([{ target: '', path: '' }]);
	});

	it('lists target and path in the empty-rule error', () => {
		expect(() => parseIgnoreRules([{}])).toThrow(/package, specifier, surface, kind, target, path/);
	});

	it('rejects malformed rules instead of silently dropping them', () => {
		expect(() => parseIgnoreRules({})).toThrow(/must be an array/);
		expect(() => parseIgnoreRules(['react'])).toThrow(/must be an object/);
		expect(() => parseIgnoreRules([{ foo: 1 }])).toThrow(/at least one of/);
		expect(() => parseIgnoreRules([{ package: 42 }])).toThrow(/package must be a string/);
		expect(() => parseIgnoreRules([{ surface: 'css' }])).toThrow(/surface must be one of/);
	});
});
