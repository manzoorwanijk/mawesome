import { defineConfig } from 'oxlint';

export default defineConfig({
	ignorePatterns: ['**/dist/**', '**/*.d.ts', '**/*.astro', '**/*.mdx'],
	categories: {
		correctness: 'error',
		suspicious: 'warn',
		perf: 'warn',
	},
	plugins: ['import', 'typescript', 'unicorn', 'promise'],
});
