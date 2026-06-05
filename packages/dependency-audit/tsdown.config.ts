import { defineConfig } from 'tsdown';

/*
 * Two outputs with different shapes:
 * - the library (`index`) is dual ESM/CJS with per-format declarations, and
 * - the CLI (`cli`) is ESM-only with no declarations — it is only ever executed
 *   via the `bin` field, never imported, so a CJS twin and `.d.ts` are dead weight.
 * Both emit .js/.cjs (not fixed .mjs/.cjs) to match the manifest, since type:module.
 */
export default defineConfig([
	{
		entry: ['src/index.ts'],
		format: ['esm', 'cjs'],
		dts: true,
		fixedExtension: false,
		platform: 'node',
		target: 'node24',
		sourcemap: true,
		clean: true,
	},
	{
		entry: ['src/cli.ts'],
		format: ['esm'],
		dts: false,
		fixedExtension: false,
		platform: 'node',
		target: 'node24',
		sourcemap: true,
		clean: false,
	},
]);
