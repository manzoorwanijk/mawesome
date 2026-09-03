import { describe, expect, it } from 'vitest';
import { harness, sha } from '../helpers/client.ts';

describe('report', () => {
	it('lists every baseline with its commit, base membership and bound PR count', async () => {
		const { client, github } = harness(
			{ baselines: [{ tag: 'repo' }, { tag: 'pkg-a', scope: ['packages/a/'] }, { tag: 'absent' }] },
			(gh) => {
				gh.tag('repo', sha(3));
				gh.commit(sha(20), [sha(2)]);
				gh.tag('pkg-a', sha(20));
				gh.commit(sha(11), [sha(4)]);
				gh.commit(sha(12), [sha(4)]);
				gh.pull({ number: 1, headSha: sha(11) });
				gh.pull({ number: 2, headSha: sha(12) });
				gh.pull({ number: 3, headSha: sha(12), baseRef: 'release/1.x' });
				gh.files.set(`${sha(5)}...${sha(11)}`, ['packages/a/x.ts']);
			},
		);
		const result = await client.report();
		expect(result).toMatchObject({ base: 'main', head: sha(5), openPulls: 2, ancestry: 'api' });
		expect(result.baselines).toEqual([
			{ tag: 'repo', sha: sha(3), onBase: true, bound: 2 },
			{ tag: 'pkg-a', scope: ['packages/a/'], sha: sha(20), onBase: false, bound: 1 },
			{ tag: 'absent', sha: null, onBase: null, bound: 2 },
		]);
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
		expect(github.requests(/\/user$/)).toHaveLength(0);
	});
});

describe('report health', () => {
	it('lists off-base baselines so the CLI can fail', async () => {
		const { client, warnings } = harness({}, (gh) => {
			gh.commit(sha(20), [sha(2)]);
			gh.tag('pr-baseline', sha(20));
		});
		const result = await client.report();
		expect(result.offBase).toEqual(['pr-baseline']);
		expect(warnings.join('\n')).toContain('not on main');
	});
});
