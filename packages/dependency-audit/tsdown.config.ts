import { defineConfig } from 'tsdown';

/*
 * Three outputs with different shapes:
 * - the library (`index`, Node) and the FS-agnostic core (`browser`) are dual ESM/CJS
 *   with per-format declarations, and
 * - the CLI (`cli`) is ESM-only with no declarations — it is only ever executed via the
 *   `bin` field, never imported, so a CJS twin and `.d.ts` are dead weight.
 * Both emit .js/.cjs (not fixed .mjs/.cjs) to match the manifest, since type:module.
 * `browser` is platform:neutral so no Node globals leak into the browser bundle.
 * `target` matches the `engines` floor (Node >=20.19) so emitted syntax never exceeds it.
 */
export default defineConfig([
	{
		entry: ['src/index.ts'],
		format: ['esm', 'cjs'],
		dts: true,
		fixedExtension: false,
		platform: 'node',
		target: 'node20.19',
		sourcemap: true,
		clean: true,
	},
	{
		entry: ['src/browser.ts'],
		format: ['esm', 'cjs'],
		dts: true,
		fixedExtension: false,
		platform: 'neutral',
		// The core imports only `node:path` (bundler-aliased to path-browserify); keep it
		// external so neutral platform doesn't warn about an unresolved Node builtin.
		external: [/^node:/],
		target: 'node20.19',
		sourcemap: true,
		clean: false,
	},
	{
		entry: ['src/cli.ts'],
		format: ['esm'],
		dts: false,
		fixedExtension: false,
		platform: 'node',
		target: 'node20.19',
		sourcemap: true,
		clean: false,
	},
]);
