import { fileURLToPath } from 'node:url';
import license from 'rollup-plugin-license';
import { defineConfig } from 'tsdown';

/*
 * The action is one self-contained ESM file: every dependency is bundled, licenses are collected
 * next to it, and no declarations are emitted since nothing imports it. `dist` is committed
 * only in the mirror repository.
 */
export default defineConfig({
	entry: { index: 'src/main.ts' },
	outDir: 'dist',
	format: ['esm'],
	platform: 'node',
	target: 'node24',
	fixedExtension: false,
	clean: true,
	sourcemap: true,
	dts: false,
	alias: {
		'@mawesome/pr-baseline': fileURLToPath(
			new URL('../../packages/pr-baseline/src/index.ts', import.meta.url),
		),
	},
	deps: { alwaysBundle: [/.*/] },
	plugins: [license({ thirdParty: { output: 'dist/licenses.txt' } })],
});
