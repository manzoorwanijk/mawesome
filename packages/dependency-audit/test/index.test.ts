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
});
