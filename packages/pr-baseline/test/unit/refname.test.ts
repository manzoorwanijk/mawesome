import { describe, expect, it } from 'vitest';
import { isValidRefName } from '../../src/refname.ts';

describe('isValidRefName', () => {
	it.each(['pr-baseline', 'baseline/packages/a', 'v1.2.3', 'a.b-c_d', 'UPPER', '@'])(
		'accepts %s',
		(name) => {
			expect(isValidRefName(name)).toBe(true);
		},
	);

	it.each([
		'',
		'/leading',
		'trailing/',
		'double//slash',
		'dot..dot',
		'.hidden',
		'dir/.hidden',
		'ends.',
		'ends.lock',
		'dir.lock/x',
		'has space',
		'tilde~',
		'caret^',
		'colon:',
		'question?',
		'star*',
		'bracket[',
		'back\\slash',
		'at@{',
		'ctrl',
		'del',
	])('rejects %j', (name) => {
		expect(isValidRefName(name)).toBe(false);
	});
});
