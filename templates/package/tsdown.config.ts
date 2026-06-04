import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts'],
	format: ['esm', 'cjs'],
	// oxc-based declarations; the strict base enables isolatedDeclarations for fast .d.ts.
	// Emits per-format declarations (.d.ts for ESM, .d.cts for CJS) to match the exports map.
	dts: true,
	platform: 'node',
	target: 'node24',
	sourcemap: true,
	clean: true,
});
