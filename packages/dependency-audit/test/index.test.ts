import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { audit, auditPackage, nodeFileSystem, type RegistryProvider } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const depsRoot = join(here, 'fixtures', 'deps');
const targetsRoot = join(here, 'fixtures', 'targets');

/** Hermetic provider: serves dep artifacts from local fixtures instead of npm. */
const fixtureProvider: RegistryProvider = {
	async materialize(name, _range, intoDir) {
		const src = join(depsRoot, name);
		if (!existsSync(src)) {
			return undefined;
		}
		cpSync(src, join(intoDir, 'node_modules', name), { recursive: true });
		const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')) as { version?: string };
		return pkg.version;
	},
};

const run = (name: string) => audit(join(targetsRoot, name), { provider: fixtureProvider });

/** The finding kind reported for `pkg` in a result (or undefined if none). */
const kindFor = (r: { findings: { packageName: string; kind: string }[] }, pkg: string) =>
	r.findings.find((f) => f.packageName === pkg)?.kind;

describe('audit (type surface)', () => {
	it('passes when every .d.ts import resolves through declared deps (incl. @types fallback)', async () => {
		const result = await run('clean');
		expect(result.ok).toBe(true);
		expect(result.findings).toEqual([]);
		expect(result.resolvedDeps).toContainEqual({
			name: '@types/react',
			range: '^18.0.0',
			version: '18.3.12',
		});
	});

	it('resolves declarations in the ESM profile mode, not the CJS union', async () => {
		/* `esm-adjacent-types` (rememo-shaped) has no `types` export condition; its `.d.ts` sits adjacent to the `import` target, so it resolves only in ESM mode — no finding.
		 * `cjs-only-types` carries its `types` condition only under `require`, invisible to the ESM profile — flagged, since an ESM consumer cannot reach those types. */
		const result = await run('esm-profile-types');
		expect(kindFor(result, 'esm-adjacent-types')).toBeUndefined();
		expect(kindFor(result, 'cjs-only-types')).toBe('missing-types');
	});

	it('honours a per-specifier `resolution-mode` attribute over the profile default', async () => {
		/* The target reaches `cjs-only-types` (typed only under `require`) via every require-mode form: a `with { 'resolution-mode': 'require' }` attribute on a top-level import and an inline `import()` type, a `resolution-mode="require"` triple-slash directive, and an `import x = require(…)`.
		 * tsc resolves each of those in CJS mode regardless of the surrounding file, so the audit must too. */
		const result = await run('resolution-mode-types');
		expect(result.ok).toBe(true);
		expect(result.findings).toEqual([]);
	});

	it('flags a declared package that ships no declarations as missing-types', async () => {
		const result = await run('missing');
		const react = result.findings.find((f) => f.packageName === 'react');
		expect(react?.kind).toBe('missing-types');
		expect(react?.surface).toBe('types');
		expect(react?.firstSeenIn).toBe(join('lib', 'index.d.ts'));
	});

	it('flags an entirely undeclared type import', async () => {
		const result = await run('missing');
		const csstype = result.findings.find((f) => f.packageName === 'csstype');
		expect(csstype?.kind).toBe('undeclared');
		expect(csstype?.suggestion).toContain('@types/csstype');
		// A genuine direct use (no declared dep exposes it) is not attributed as a leak.
		expect(csstype?.leakedVia).toBeUndefined();
	});

	it('attributes a leaked type to the declared dependency whose API exposes it', async () => {
		const result = await run('type-leak');
		// `leaked-lib` is undeclared and never imported directly — it enters via `leaky-core`.
		const leak = result.findings.find((f) => f.packageName === 'leaked-lib');
		expect(leak).toMatchObject({ surface: 'types', kind: 'undeclared', leakedVia: ['leaky-core'] });
		expect(leak?.suggestion).toContain('also exposed by declared dependency "leaky-core"');
		// `leaky-core` itself is declared and resolves — no finding for it.
		expect(result.findings.some((f) => f.packageName === 'leaky-core')).toBe(false);
	});

	it('lists every declared dependency that exposes a leaked type', async () => {
		const result = await run('type-leak-multi');
		const leak = result.findings.find((f) => f.packageName === 'leaked-lib');
		expect(leak?.leakedVia).toEqual(expect.arrayContaining(['leaky-core', 'leaky-core2']));
		expect(leak?.leakedVia).toHaveLength(2);
	});

	it('does not attribute a directly-imported package as a leak, even if a dep also exposes it', async () => {
		// The consumer writes a top-level `import … from 'leaked-lib'` (a direct use), while declared
		// `leaky-core` also exposes `leaked-lib`. A direct import is author-written, not a synthesized
		// leak, so it must stay a plain `undeclared` finding with no `leakedVia`.
		const result = await run('direct-use-types');
		const finding = result.findings.find((f) => f.packageName === 'leaked-lib');
		expect(finding?.kind).toBe('undeclared');
		expect(finding?.leakedVia).toBeUndefined();
	});

	describe('registry-aware @types refinement (missing-types → types-unavailable)', () => {
		const withProbe = (verdict: 'exists' | 'absent' | 'unknown'): RegistryProvider => ({
			materialize: (name, range, intoDir) => fixtureProvider.materialize(name, range, intoDir),
			packageExists: () => Promise.resolve(verdict),
		});

		it('reclassifies missing-types as types-unavailable when no @types companion exists', async () => {
			const result = await audit(join(targetsRoot, 'missing'), { provider: withProbe('absent') });
			const react = result.findings.find((f) => f.packageName === 'react');
			expect(react?.kind).toBe('types-unavailable');
			expect(react?.suggestion).toContain('not fixable by declaring a dependency');
			// An `undeclared` finding is never reclassified (only its advice is refined).
			expect(kindFor(result, 'csstype')).toBe('undeclared');
		});

		it('keeps missing-types when the @types companion exists, is unknown, or the provider cannot probe', async () => {
			expect(
				kindFor(
					await audit(join(targetsRoot, 'missing'), { provider: withProbe('exists') }),
					'react',
				),
			).toBe('missing-types');
			expect(
				kindFor(
					await audit(join(targetsRoot, 'missing'), { provider: withProbe('unknown') }),
					'react',
				),
			).toBe('missing-types');
			// The plain fixture provider has no `packageExists` capability → refinement is skipped.
			expect(kindFor(await run('missing'), 'react')).toBe('missing-types');
		});

		it('suggests a version that ships types instead of types-unavailable when one exists', async () => {
			// No `@types/react`, but a published `react` version ships its own types.
			const provider: RegistryProvider = {
				materialize: (name, range, intoDir) => fixtureProvider.materialize(name, range, intoDir),
				packageExists: () => Promise.resolve('absent'),
				latestTypedVersion: () => Promise.resolve('99.0.0'),
			};
			const result = await audit(join(targetsRoot, 'missing'), { provider });
			const react = result.findings.find((f) => f.packageName === 'react');
			// Stays a (fixable) missing-types — not the dead-end types-unavailable.
			expect(react?.kind).toBe('missing-types');
			expect(react?.suggestion).toContain('"react@99.0.0" ships its own types');
		});

		it('does not refine a subpath gap on a package that ships its own (root) types', async () => {
			// `typed-root` ships root types via an implicit `index.d.ts` (no `types` field — so the gate
			// must be resolution-based, not manifest-field-based); the failing import is a subpath it
			// doesn't expose, so the @types/version-bump/unavailable refinement must not apply.
			const provider: RegistryProvider = {
				materialize: (name, range, intoDir) => fixtureProvider.materialize(name, range, intoDir),
				packageExists: () => Promise.resolve('absent'),
				latestTypedVersion: () => Promise.resolve('9.9.9'),
			};
			const result = await audit(join(targetsRoot, 'subpath-types'), { provider });
			const finding = result.findings.find((f) => f.packageName === 'typed-root');
			expect(finding?.kind).toBe('missing-types'); // not types-unavailable
			expect(finding?.suggestion).not.toContain('depend on that version');
			// A subpath gap is qualified: the companion/version may not declare this exact subpath.
			expect(finding?.suggestion).toContain('subpath "typed-root/sub"');
			expect(finding?.suggestion).toContain('declare module "typed-root/sub"');
		});

		it('qualifies the typed-version-bump suggestion for a subpath gap too', async () => {
			// `react` ships no types and the import is a subpath, so the typed-version-bump path fires;
			// the suggestion must still name the subpath and the `declare module` fallback.
			const provider: RegistryProvider = {
				materialize: (name, range, intoDir) => fixtureProvider.materialize(name, range, intoDir),
				packageExists: () => Promise.resolve('absent'),
				latestTypedVersion: () => Promise.resolve('99.0.0'),
			};
			const result = await audit(join(targetsRoot, 'subpath-untyped'), { provider });
			const finding = result.findings.find((f) => f.packageName === 'react');
			expect(finding?.kind).toBe('missing-types');
			expect(finding?.suggestion).toContain('"react@99.0.0" ships its own types');
			expect(finding?.suggestion).toContain('declare module "react/jsx-runtime"');
		});

		it('does not qualify a bare-entry missing-types finding with the subpath caveat', async () => {
			// `missing` imports bare `react` (specifier === packageName), so no subpath note applies.
			const react = (await run('missing')).findings.find((f) => f.packageName === 'react');
			expect(react?.kind).toBe('missing-types');
			expect(react?.suggestion).not.toContain('subpath');
		});

		it('falls back to types-unavailable when no published version ships types', async () => {
			const provider: RegistryProvider = {
				materialize: (name, range, intoDir) => fixtureProvider.materialize(name, range, intoDir),
				packageExists: () => Promise.resolve('absent'),
				latestTypedVersion: () => Promise.resolve(undefined),
			};
			expect(kindFor(await audit(join(targetsRoot, 'missing'), { provider }), 'react')).toBe(
				'types-unavailable',
			);
		});

		it('lets a types-unavailable finding be suppressed by kind', async () => {
			const result = await audit(join(targetsRoot, 'missing'), {
				provider: withProbe('absent'),
				ignore: [{ kind: 'types-unavailable' }],
			});
			expect(result.findings.some((f) => f.packageName === 'react')).toBe(false);
			expect(result.ignored.some((f) => f.kind === 'types-unavailable')).toBe(true);
		});

		it('keeps an existing missing-types ignore matching even when the gap would be reclassified', async () => {
			// The react gap is suppressed as `missing-types` *before* refinement, so it must stay
			// ignored — refinement must never turn a suppressed finding into a failing one.
			const result = await audit(join(targetsRoot, 'missing'), {
				provider: withProbe('absent'),
				ignore: [{ kind: 'missing-types' }],
			});
			expect(result.findings.some((f) => f.packageName === 'react')).toBe(false);
			expect(
				result.ignored.some((f) => f.packageName === 'react' && f.kind === 'missing-types'),
			).toBe(true);
		});

		it('probes the @types companion of missing-types and undeclared findings alike', async () => {
			const probed: string[] = [];
			const provider: RegistryProvider = {
				materialize: (name, range, intoDir) => fixtureProvider.materialize(name, range, intoDir),
				packageExists: (name) => {
					probed.push(name);
					return Promise.resolve('exists');
				},
			};
			await audit(join(targetsRoot, 'missing'), { provider });
			// `react` is missing-types (reclassification probe); `csstype` is undeclared (advice probe).
			expect(probed.toSorted()).toEqual(['@types/csstype', '@types/react']);
		});

		it('drops the @types alternative from an undeclared finding when no companion exists', async () => {
			const result = await audit(join(targetsRoot, 'missing'), { provider: withProbe('absent') });
			const csstype = result.findings.find((f) => f.packageName === 'csstype');
			// The kind is untouched; only the dead-end alternative disappears from the advice.
			expect(csstype?.kind).toBe('undeclared');
			expect(csstype?.suggestion).toBe('declare "csstype"');
		});

		it('drops the @types alternative from a leak suggestion when no companion exists', async () => {
			const result = await audit(join(targetsRoot, 'type-leak'), { provider: withProbe('absent') });
			const leak = result.findings.find((f) => f.packageName === 'leaked-lib');
			expect(leak?.suggestion).toContain('declare "leaked-lib" yourself');
			expect(leak?.suggestion).not.toContain('@types/leaked-lib');
			// The leak attribution itself is unaffected.
			expect(leak?.leakedVia).toEqual(['leaky-core']);
		});

		it('keeps the hedged @types alternative when the companion exists or is unknown', async () => {
			const suggestionFor = async (verdict: 'exists' | 'unknown') =>
				(await audit(join(targetsRoot, 'missing'), { provider: withProbe(verdict) })).findings.find(
					(f) => f.packageName === 'csstype',
				)?.suggestion;
			expect(await suggestionFor('exists')).toContain('"@types/csstype" if it ships no types');
			expect(await suggestionFor('unknown')).toContain('"@types/csstype" if it ships no types');
		});

		it('leaves the builtin @types/node advice alone even when the probe says absent', async () => {
			// A builtin's fix is always "@types/node" (which exists); the advice probe must skip it.
			const result = await audit(join(targetsRoot, 'builtin-missing'), {
				provider: withProbe('absent'),
			});
			const builtin = result.findings.find((f) => f.suggestion.includes('@types/node'));
			expect(builtin?.kind).toBe('undeclared');
		});

		it('keeps the @types alternative for a type-reference directive even when the probe says absent', async () => {
			// `/// <reference types="node" />` resolves *through* `@types/node` — dropping that alternative would point away from the directive's actual fix.
			const result = await audit(join(targetsRoot, 'typeref'), { provider: withProbe('absent') });
			const node = result.findings.find((f) => f.packageName === 'node');
			expect(node?.kind).toBe('undeclared');
			expect(node?.suggestion).toContain('@types/node');
		});

		it('does not probe a finding already suppressed (refinement runs only on survivors)', async () => {
			const probed: string[] = [];
			const provider: RegistryProvider = {
				materialize: (name, range, intoDir) => fixtureProvider.materialize(name, range, intoDir),
				packageExists: (name) => {
					probed.push(name);
					return Promise.resolve('absent');
				},
			};
			await audit(join(targetsRoot, 'missing'), { provider, ignore: [{ kind: 'missing-types' }] });
			// react's gap is suppressed before refinement, so its companion is never even looked up.
			expect(probed).not.toContain('@types/react');
		});

		it('binds packageExists to its receiver (a class-backed provider using `this`)', async () => {
			// If the method were called unbound, `this.verdict` would throw — so this locks down the binding.
			class ClassProvider implements RegistryProvider {
				private readonly verdict = 'absent' as const;
				materialize(name: string, range: string, intoDir: string): Promise<string | undefined> {
					return fixtureProvider.materialize(name, range, intoDir);
				}
				packageExists(): Promise<'exists' | 'absent' | 'unknown'> {
					return Promise.resolve(this.verdict);
				}
			}
			const result = await audit(join(targetsRoot, 'missing'), { provider: new ClassProvider() });
			expect(kindFor(result, 'react')).toBe('types-unavailable');
		});
	});

	it('accepts a Node builtin type reference when @types/node is declared', async () => {
		const result = await run('builtin-ok');
		expect(result.ok).toBe(true);
	});

	it('flags a Node builtin type reference when @types/node is missing', async () => {
		const result = await run('builtin-missing');
		const finding = result.findings.find((f) => f.packageName === 'path');
		expect(finding?.kind).toBe('undeclared');
		expect(finding?.suggestion).toContain('@types/node');
		// A builtin is never a leak candidate, so it's not attributed to a dependency.
		expect(finding?.leakedVia).toBeUndefined();
	});

	it('scans deep-importable .d.ts files when there is no exports field', async () => {
		const result = await run('no-exports');
		const csstype = result.findings.find((f) => f.packageName === 'csstype');
		// `deep.d.ts` is not referenced by the entry — only whole-tarball scanning finds it.
		expect(csstype?.firstSeenIn).toBe(join('lib', 'deep.d.ts'));
		expect(csstype?.kind).toBe('undeclared');
	});

	it('treats a `declare module "x"` augmentation as a requirement, ignoring pattern stubs', async () => {
		const result = await run('augment');
		expect(result.findings.find((f) => f.packageName === 'react')?.kind).toBe('undeclared');
		// The `declare module "*.svg"` pattern stub must not produce a finding.
		expect(result.findings.every((f) => !f.specifier.includes('*'))).toBe(true);
	});

	it('resolves `/// <reference types="x" />` as a type-reference directive', async () => {
		const result = await run('typeref');
		const node = result.findings.find((f) => f.packageName === 'node');
		expect(node?.surface).toBe('types');
		expect(node?.suggestion).toContain('@types/node');
	});

	it('suppresses findings matched by an ignore rule and surfaces them as ignored', async () => {
		const result = await audit(join(targetsRoot, 'missing'), {
			provider: fixtureProvider,
			ignore: [{ package: 'csstype' }],
		});
		// csstype is suppressed; react remains and still fails the audit.
		expect(result.findings.some((f) => f.packageName === 'csstype')).toBe(false);
		expect(result.ignored.some((f) => f.packageName === 'csstype')).toBe(true);
		expect(result.findings.some((f) => f.packageName === 'react')).toBe(true);
		expect(result.ok).toBe(false);
	});

	it('scopes a target/path ignore rule via the run context threaded through auditPackage', async () => {
		// `@fixture/missing` reports csstype in lib/index.d.ts; scope by package name + path.
		const scoped = { target: '@fixture/missing', path: 'lib/**', package: 'csstype' };
		const matched = await audit(join(targetsRoot, 'missing'), {
			provider: fixtureProvider,
			ignore: [scoped],
		});
		expect(matched.ignored.some((f) => f.packageName === 'csstype')).toBe(true);
		expect(matched.findings.some((f) => f.packageName === 'csstype')).toBe(false);

		// A rule scoped to a different target must not suppress here (proves the name is threaded).
		const otherTarget = await audit(join(targetsRoot, 'missing'), {
			provider: fixtureProvider,
			ignore: [{ ...scoped, target: 'some-other-pkg' }],
		});
		expect(otherTarget.findings.some((f) => f.packageName === 'csstype')).toBe(true);
	});

	it('is ok when an ignore rule suppresses every finding', async () => {
		const result = await audit(join(targetsRoot, 'missing'), {
			provider: fixtureProvider,
			ignore: [{ surface: 'types' }],
		});
		expect(result.findings).toEqual([]);
		expect(result.ignored.length).toBeGreaterThan(0);
		expect(result.ok).toBe(true);
	});

	it('expands `exports` subpath patterns (./*) to reach wildcard-only entry points', async () => {
		const result = await run('wildcard');
		// Both files are reachable only via the `./*` pattern export.
		expect(result.findings.find((f) => f.packageName === 'csstype')?.surface).toBe('types');
		expect(result.findings.find((f) => f.packageName === 'ghost')?.surface).toBe('runtime');
	});

	it('scopes the type surface to a typesVersions catch-all, excluding sibling dirs', async () => {
		const result = await run('typesversions');
		// `typesVersions: { "*": { "*": ["dist/*"] } }` redirects all types into dist/, so the
		// undeclared `ghost` import in src/legacy.d.ts is outside the surface and not flagged.
		expect(result.findings.some((f) => f.packageName === 'ghost')).toBe(false);
		expect(result.ok).toBe(true);
	});
});

describe('audit (publish set in directory mode)', () => {
	/*
	 * `@fixture/pack-set` has `files: ["lib"]` plus a string `bin: "./bin/cli.js"`: lib/index.js
	 * requires `published-ghost` and the (force-included) bin requires `bin-ghost`, while the
	 * excluded test/ and src/ files require `excluded-ghost`/`src-ghost`.
	 */
	const packSetTarget = join(targetsRoot, 'pack-set');

	it('audits only what npm would publish, ignoring references in excluded files', async () => {
		const result = await audit(packSetTarget, { provider: fixtureProvider });
		// The undeclared require in a *published* file is flagged…
		expect(result.findings.find((f) => f.packageName === 'published-ghost')).toMatchObject({
			surface: 'runtime',
			kind: 'undeclared',
		});
		// …a `bin` is force-included even though it's outside `files` (exercises bin normalization)…
		expect(result.findings.some((f) => f.packageName === 'bin-ghost')).toBe(true);
		// …but `files: ["lib"]` excludes test/ and src/, so their requires are never scanned.
		expect(result.findings.some((f) => f.packageName === 'excluded-ghost')).toBe(false);
		expect(result.findings.some((f) => f.packageName === 'src-ghost')).toBe(false);
	});

	it('honors .npmignore for a package without a files allowlist', async () => {
		const result = await audit(join(targetsRoot, 'pack-set-npmignore'), {
			provider: fixtureProvider,
		});
		// Published root file is scanned; the `.npmignore`-excluded internal/ dir is not.
		expect(result.findings.some((f) => f.packageName === 'kept-ghost')).toBe(true);
		expect(result.findings.some((f) => f.packageName === 'ignored-ghost')).toBe(false);
	});

	it('without the publish-set filter, scans the excluded files too (proves the filter is the cause)', async () => {
		// auditPackage on the raw directory, with no `includeFiles`, is the unfiltered behavior.
		const workDir = mkdtempSync(join(tmpdir(), 'da-packset-'));
		try {
			const result = await auditPackage(nodeFileSystem, packSetTarget, {
				provider: fixtureProvider,
				workDir,
			});
			expect(result.findings.some((f) => f.packageName === 'excluded-ghost')).toBe(true);
			expect(result.findings.some((f) => f.packageName === 'src-ghost')).toBe(true);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
		}
	});
});
