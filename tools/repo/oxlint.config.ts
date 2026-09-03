import { defineConfig } from 'oxlint';

export default defineConfig({
	ignorePatterns: ['**/dist/**', '**/*.d.ts', '**/*.astro', '**/*.mdx'],
	categories: {
		correctness: 'error',
		suspicious: 'warn',
		perf: 'warn',
	},
	plugins: ['import', 'typescript', 'unicorn', 'promise'],
	overrides: [
		{
			// pr-baseline talks to a rate-limited API; its sequential awaits are the pacing, not an oversight.
			files: ['**/packages/pr-baseline/**'],
			rules: { 'no-await-in-loop': 'off' },
		},
	],
});
