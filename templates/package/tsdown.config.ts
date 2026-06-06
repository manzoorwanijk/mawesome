import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts'],
	format: ['esm', 'cjs'],
	// oxc-based declarations; the strict base enables isolatedDeclarations for fast .d.ts.
	// Emits per-format declarations (.d.ts for ESM, .d.cts for CJS) to match the exports map.
	dts: true,
	// Emit .js/.cjs (+ .d.ts/.d.cts) to match the manifest, since the package is type:module.
	// tsdown otherwise defaults to fixed .mjs/.cjs, which would break the exports/types map.
	fixedExtension: false,
	platform: 'node',
	target: 'node24',
	sourcemap: true,
	clean: true,
});
