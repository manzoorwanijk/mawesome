import { defineConfig } from 'oxlint';

export default defineConfig({
	ignorePatterns: ['**/dist/**', '**/*.d.ts'],
	categories: {
		correctness: 'error',
		suspicious: 'warn',
		perf: 'warn',
	},
	plugins: ['import', 'typescript', 'unicorn', 'promise'],
});
