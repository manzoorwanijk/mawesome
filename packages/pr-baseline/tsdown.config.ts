import { defineConfig } from 'tsdown';

/*
 * The library is dual ESM/CJS with per-format declarations.
 * The CLI is ESM-only without declarations: it is executed through `bin`, never imported.
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
