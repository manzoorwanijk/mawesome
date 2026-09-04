import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		// The action imports the published package name; in the monorepo that is this source tree.
		alias: { '@mawesome/pr-baseline': fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
	},
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
	},
});
