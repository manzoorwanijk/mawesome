import { describe, expect, it } from 'vitest';
import { harness, sha } from '../helpers/client.ts';
import type { FakeGitHub } from '@mawesome/testing/github';

describe('report', () => {
	it('lists every baseline with its commit, base membership and bound PR count', async () => {
		const { client, github } = harness(
			{
				baselines: [
					{ name: 'repo' },
					{ name: 'pkg-a', scope: ['packages/a/'] },
					{ name: 'absent' },
				],
			},
			(gh) => {
				gh.baseline('repo', sha(3));
				gh.commit(sha(20), [sha(2)]);
				gh.baseline('pkg-a', sha(20));
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
			{ name: 'repo', sha: sha(3), onBase: true, bound: 2 },
			{ name: 'pkg-a', scope: ['packages/a/'], sha: sha(20), onBase: false, bound: 1 },
			{ name: 'absent', sha: null, onBase: null, bound: 2 },
		]);
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
		expect(github.requests(/\/user$/)).toHaveLength(0);
	});
});

/** Four open PRs, one of each state the context can carry. */
function mixed(gh: FakeGitHub): void {
	gh.baseline('pr-baseline', sha(3));
	for (const n of [11, 12, 13, 14]) {
		gh.commit(sha(n), [sha(4)]);
		gh.pull({ number: n - 10, headSha: sha(n) });
	}
	gh.status(sha(11), { state: 'success', description: 'Contains the required main changes.' });
	gh.status(sha(12), { state: 'failure', description: 'Merge or rebase main to include: x' });
	gh.status(sha(13), { state: 'error', description: 'left by a previous integration' });
}

describe('report readiness', () => {
	it('breaks the open PRs down by the status they carry, with the API adapter too', async () => {
		const { client } = harness({}, mixed);
		const result = await client.report();
		expect(result).toMatchObject({
			ancestry: 'api',
			openPulls: 4,
			passing: 1,
			failing: 1,
			other: 1,
			unstamped: 1,
		});
		expect(result.passing + result.failing + result.other + result.unstamped).toBe(
			result.openPulls,
		);
		// Verdicts need the git adapter, but the breakdown comes from the listing alone.
		expect(result.stale).toBeUndefined();
	});

	it('breaks them down even when a baseline is off the base branch', async () => {
		const { client } = harness({}, (gh) => {
			mixed(gh);
			gh.commit(sha(20), [sha(2)]);
			gh.baseline('pr-baseline', sha(20));
		});
		await expect(client.report()).resolves.toMatchObject({
			offBase: ['pr-baseline'],
			passing: 1,
			unstamped: 1,
		});
	});
});

describe('report health', () => {
	it('lists off-base baselines so the CLI can fail', async () => {
		const { client, warnings } = harness({}, (gh) => {
			gh.commit(sha(20), [sha(2)]);
			gh.baseline('pr-baseline', sha(20));
		});
		const result = await client.report();
		expect(result.offBase).toEqual(['pr-baseline']);
		expect(warnings.join('\n')).toContain('not on main');
	});
});
