import { fileURLToPath } from 'node:url';
import license from 'rollup-plugin-license';
import { defineConfig } from 'tsdown';

/*
 * The action is one self-contained ESM file: every dependency is bundled, licenses are collected
 * next to it, and no declarations are emitted since nothing imports it. `action/dist` is committed
 * only in the mirror repository.
 */
export default defineConfig({
	entry: { index: 'action/src/main.ts' },
	outDir: 'action/dist',
	format: ['esm'],
	platform: 'node',
	target: 'node24',
	fixedExtension: false,
	clean: true,
	sourcemap: true,
	dts: false,
	alias: { '@mawesome/pr-baseline': fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
	deps: { alwaysBundle: [/.*/] },
	plugins: [license({ thirdParty: { output: 'action/dist/licenses.txt' } })],
});
