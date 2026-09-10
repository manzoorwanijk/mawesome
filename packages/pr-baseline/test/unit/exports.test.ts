import { describe, expect, it } from 'vitest';
import * as api from '../../src/index.ts';

/** The package root is the published surface; a rename here is a breaking change whatever the types say. */
describe('public exports', () => {
	it('exports compareStatus and no longer exports statusMatches', () => {
		expect(typeof api.compareStatus).toBe('function');
		expect('statusMatches' in api).toBe(false);
	});

	it('exports the helpers the docs name', () => {
		for (const name of [
			'createClient',
			'computeVerdict',
			'renderDescription',
			'boundDescription',
			'compareStatus',
			'createProgressThrottle',
			'sameRefs',
			'validateBaselines',
			'parseBaselines',
			'shorthandBaselines',
			'createMatcher',
			'DEFAULT_SCOPE',
		]) {
			expect(name in api).toBe(true);
		}
	});
});
