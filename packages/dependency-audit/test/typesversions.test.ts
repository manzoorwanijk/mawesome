import { describe, expect, it } from 'vitest';
import { activeTypesVersions } from '../src/typesversions.ts';

describe('activeTypesVersions', () => {
	it('returns undefined for absent or non-object typesVersions', () => {
		expect(activeTypesVersions(undefined, '6.0.3')).toBeUndefined();
		expect(activeTypesVersions('nope', '6.0.3')).toBeUndefined();
	});

	it('selects the first matching version range and flags a catch-all', () => {
		const tv = { '<4.0': { '*': ['ts3/*'] }, '*': { '*': ['dist/*'] } };
		expect(activeTypesVersions(tv, '6.0.3')).toEqual({ catchAll: true, targets: ['dist/*'] });
	});

	it('matches comparator ranges against the TS version', () => {
		const tv = { '>=4.0': { '.': ['modern.d.ts'] } };
		expect(activeTypesVersions(tv, '6.0.3')).toEqual({ catchAll: false, targets: ['modern.d.ts'] });
		expect(activeTypesVersions(tv, '3.9.0')).toBeUndefined();
	});

	it('honors the first match even when a later range would also match', () => {
		const tv = { '<5.0': { '*': ['old/*'] }, '>=5.0': { '*': ['new/*'] } };
		expect(activeTypesVersions(tv, '6.0.3')?.targets).toEqual(['new/*']);
		expect(activeTypesVersions(tv, '4.9.0')?.targets).toEqual(['old/*']);
	});

	it('does not activate a mapping behind a malformed (non-anchored) range', () => {
		const tv = { '>=4.0junk': { '*': ['bad/*'] }, '*': { '*': ['dist/*'] } };
		// The junk range must not match; the next (`*`) wins.
		expect(activeTypesVersions(tv, '6.0.3')?.targets).toEqual(['dist/*']);
	});

	it('stops at the first matching range even if its mapping is malformed', () => {
		const tv = { '*': 'not-an-object', '>=4.0': { '*': ['fallback/*'] } };
		expect(activeTypesVersions(tv, '6.0.3')).toBeUndefined();
	});
});
