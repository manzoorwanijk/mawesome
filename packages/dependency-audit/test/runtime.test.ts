import { cpSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { audit, type RegistryProvider } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const depsRoot = join(here, 'fixtures', 'deps');
const targetsRoot = join(here, 'fixtures', 'targets');

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

describe('audit (runtime surface)', () => {
	it('passes when every runtime import resolves (legacy main, exports, relative graph)', async () => {
		const result = await run('runtime-ok');
		expect(result.findings.filter((f) => f.surface === 'runtime')).toEqual([]);
	});

	it('flags an undeclared runtime import and ignores Node builtins', async () => {
		const result = await run('runtime-undeclared');
		const leftpad = result.findings.find((f) => f.packageName === 'leftpad');
		expect(leftpad).toMatchObject({ surface: 'runtime', kind: 'undeclared' });
		// `node:fs/promises` is a builtin — never a runtime finding.
		expect(result.findings.some((f) => f.packageName === 'fs')).toBe(false);
		// The non-literal dynamic import is surfaced as unchecked, not dropped.
		expect(result.unchecked.length).toBeGreaterThan(0);
	});

	it('checks template-literal specifiers and ignores a local `require` in ESM', async () => {
		const result = await run('runtime-undeclared');
		// `import(`tmpl-dep`)` is a literal — audited.
		expect(result.findings.find((f) => f.packageName === 'tmpl-dep')).toMatchObject({
			surface: 'runtime',
			kind: 'undeclared',
		});
		// A user-defined `require` in an ESM module is not a CommonJS require.
		expect(result.findings.some((f) => f.packageName === 'ghost')).toBe(false);
	});

	it('discovers an extensionless `#!/usr/bin/env node` bin as a runtime entry', async () => {
		const result = await run('bin-shebang');
		expect(result.findings.find((f) => f.packageName === 'leftpad')).toMatchObject({
			surface: 'runtime',
			kind: 'undeclared',
			firstSeenIn: 'cli',
		});
	});

	it('flags a deep import of a subpath the dep does not export as unresolved', async () => {
		const result = await run('runtime-subpath');
		// `exporter/sub` resolves; `exporter/private` does not.
		expect(result.findings.find((f) => f.specifier === 'exporter/sub')).toBeUndefined();
		const priv = result.findings.find((f) => f.specifier === 'exporter/private');
		expect(priv).toMatchObject({ surface: 'runtime', kind: 'unresolved', packageName: 'exporter' });
	});

	it('resolves an `npm:` aliased dep whose materialized manifest keeps its real name', async () => {
		const result = await run('runtime-npm-alias');
		/* Each dep materializes under its alias key but reports a different real name.
		 * Bare, deep, scoped, and legacy (no-`exports`) specifiers all resolve. */
		expect(result.findings.filter((f) => f.surface === 'runtime')).toEqual([]);
	});

	it('extracts require() specifiers from a CJS entry (require call form)', async () => {
		const result = await run('runtime-require');
		expect(result.findings.find((f) => f.packageName === 'leftpad')).toBeUndefined();
		expect(result.findings.find((f) => f.packageName === 'missingdep')).toMatchObject({
			surface: 'runtime',
			kind: 'undeclared',
		});
	});

	it('extracts require.resolve, createRequire(...)(), and import-attributes specifiers', async () => {
		const result = await run('require-forms');
		const undeclared = (pkg: string) =>
			result.findings.find((f) => f.packageName === pkg && f.surface === 'runtime');
		expect(undeclared('res-dep')).toBeDefined(); // require.resolve('res-dep') (CJS)
		expect(undeclared('cr-dep')).toBeDefined(); // createRequire(__filename)('cr-dep') (CJS)
		expect(undeclared('cr-esm-dep')).toBeDefined(); // createRequire(import.meta.url)('…') (ESM)
		expect(undeclared('crr-dep')).toBeDefined(); // createRequire(import.meta.url).resolve('…')
		expect(undeclared('attr-dep')).toBeDefined(); // import … from 'attr-dep' with { type: 'json' }
		// `module` is a Node builtin — never a finding.
		expect(result.findings.some((f) => f.packageName === 'module')).toBe(false);
	});
});
