import { describe, expect, it } from 'vitest';
import { harness, sha } from '../helpers/client.ts';

describe('refresh-pr-status with baseRef', () => {
	it('applies the other-bases rule to a ref as well as to a full SHA', async () => {
		const { client, github } = harness({}, (fake) => {
			fake.tag('pr-baseline', sha(3));
			fake.commit(sha(12), [sha(2)]);
			fake.branch('topic', sha(12));
		});
		for (const target of ['topic', sha(12)]) {
			const result = await client.refreshPrStatus({
				sha: target,
				baseRef: 'release',
				report: true,
			});
			expect(result.outOfScope).toBe(true);
			expect(result.written).toBe(false);
		}
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
		const onBase = await client.refreshPrStatus({ sha: 'topic', baseRef: 'main', report: true });
		expect(onBase.written).toBe(true);
	});
});
