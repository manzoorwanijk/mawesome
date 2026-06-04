import { describe, expect, it } from 'vitest';
import { findRootDepViolations } from '../scripts/check-root-deps.ts';

describe('findRootDepViolations', () => {
	it('passes for empty dependencies and only @changesets/* devDependencies', () => {
		const violations = findRootDepViolations({
			devDependencies: {
				'@changesets/cli': 'catalog:',
				'@changesets/changelog-github': 'catalog:',
			},
		});
		expect(violations).toEqual([]);
	});

	it('flags any runtime dependencies', () => {
		const violations = findRootDepViolations({ dependencies: { lodash: '^4.17.0' } });
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain('dependencies');
	});

	it('flags devDependencies outside the allowlist', () => {
		const violations = findRootDepViolations({ devDependencies: { oxlint: '^1.0.0' } });
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain('oxlint');
	});
});
