import { cpSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { audit, type RegistryProvider } from '../src/index.ts';

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
