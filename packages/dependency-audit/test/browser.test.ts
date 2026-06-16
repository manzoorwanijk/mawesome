import { describe, expect, it } from 'vitest';
import {
	auditPackage,
	createMemoryFileSystem,
	type RegistryProvider,
	type WritableFileSystem,
} from '../src/browser.ts';

describe('createMemoryFileSystem', () => {
	it('treats root and trailing-slash directory spellings consistently', () => {
		const fs = createMemoryFileSystem();
		fs.writeFile('/a/b/file.js', 'x');
		expect(fs.isDirectory('/')).toBe(true);
		expect(fs.isDirectory('/a')).toBe(true);
		expect(fs.isDirectory('/a/')).toBe(true);
		expect(fs.isFile('/a/b/file.js')).toBe(true);
		expect(fs.isFile('/a/b')).toBe(false);
		// A trailing slash denotes a directory, so a file lookup misses (matches Node).
		expect(fs.isFile('/a/b/file.js/')).toBe(false);
		expect(fs.listDir('/a')).toEqual(['b']);
		expect(fs.readdirRecursive('/')).toContain('a/b/file.js');
	});
});

/*
 * Proves the core runs entirely over an in-memory filesystem — no node:fs, no pacote —
 * which is exactly what a browser playground needs. Both surfaces are exercised: the type
 * surface resolves csstype's declarations through the TS host over the virtual FS, and the
 * runtime surface resolves csstype via legacy main; `ghost`/`phantom` stay undeclared.
 */

/** A tiny in-memory dep registry the provider materializes from. */
const DEP_FILES: Record<string, Record<string, string>> = {
	csstype: {
		'package.json': JSON.stringify({
			name: 'csstype',
			version: '3.1.3',
			types: './index.d.ts',
			main: './index.js',
		}),
		'index.d.ts': 'export interface Properties { color?: string }\n',
		'index.js': 'export const c = 1;\n',
	},
};

function memoryProvider(fs: WritableFileSystem): RegistryProvider {
	return {
		async materialize(name, _range, intoDir) {
			const files = DEP_FILES[name];
			if (files === undefined) {
				return undefined;
			}
			for (const [rel, content] of Object.entries(files)) {
				fs.writeFile(`${intoDir}/node_modules/${name}/${rel}`, content);
			}
			return JSON.parse(files['package.json'] ?? '{}').version as string | undefined;
		},
	};
}

function seedTarget(fs: WritableFileSystem): void {
	fs.writeFile(
		'/pkg/package.json',
		JSON.stringify({
			name: '@demo/pkg',
			version: '1.0.0',
			type: 'module',
			exports: { '.': { import: { types: './lib/index.d.ts', default: './lib/index.js' } } },
			dependencies: { csstype: '^3.0.0' },
		}),
	);
	fs.writeFile(
		'/pkg/lib/index.d.ts',
		"import type { Properties } from 'csstype';\n" +
			"export type { Other } from 'phantom';\n" +
			'export declare const x: Properties;\n',
	);
	fs.writeFile(
		'/pkg/lib/index.js',
		"import { c } from 'csstype';\nimport { g } from 'ghost';\nexport const y = c + g;\n",
	);
}

/*
 * The in-memory adapter is the browser path: there `node:path` is aliased to path-browserify
 * (POSIX), so it stays consistent with the POSIX-keyed tree. Driving the same core over the
 * in-memory FS on Windows-Node mixes win32 `node:path` joins with POSIX keys — a config that never
 * ships (the CLI uses the real Node FS, covered by cli.test on Windows). Pin these to POSIX.
 */
describe.skipIf(process.platform === 'win32')(
	'auditPackage over an in-memory filesystem (browser-ready)',
	() => {
		it('audits both surfaces with no Node filesystem access', async () => {
			const fs = createMemoryFileSystem();
			seedTarget(fs);

			const result = await auditPackage(fs, '/pkg', {
				provider: memoryProvider(fs),
				workDir: '/work',
				target: '@demo/pkg',
			});

			expect(result.ok).toBe(false);
			// csstype resolves on both surfaces — no finding.
			expect(result.findings.some((f) => f.packageName === 'csstype')).toBe(false);
			// Undeclared on each surface.
			expect(result.findings.find((f) => f.packageName === 'ghost')).toMatchObject({
				surface: 'runtime',
				kind: 'undeclared',
			});
			expect(result.findings.find((f) => f.packageName === 'phantom')).toMatchObject({
				surface: 'types',
				kind: 'undeclared',
			});
			expect(result.resolvedDeps).toContainEqual({
				name: 'csstype',
				range: '^3.0.0',
				version: '3.1.3',
			});
		});
	},
);
