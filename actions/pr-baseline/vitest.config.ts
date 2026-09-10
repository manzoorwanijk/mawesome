import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		// The action imports the published package name; in the monorepo that is the library's entry.
		alias: {
			'@mawesome/pr-baseline': fileURLToPath(
				new URL('../../packages/pr-baseline/src/index.ts', import.meta.url),
			),
		},
	},
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
	},
});
