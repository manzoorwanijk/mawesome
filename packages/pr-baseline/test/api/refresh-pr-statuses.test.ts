import { describe, expect, it } from 'vitest';
import { GitError } from '../../src/git/repo.ts';
import { GitHubError } from '../../src/github/errors.ts';
import type { Ancestry } from '../../src/index.ts';
import { harness, sha } from '../helpers/client.ts';
import type { FakeGitHub } from '../helpers/fake-github.ts';

const PASS = 'Contains the required main changes.';

/** Baseline at 3; PRs 1 (current), 2 (stale), 3 (stale but already stamped), 4 (current, wrong creator). */
function populate(gh: FakeGitHub): void {
	gh.baseline('pr-baseline', sha(3));
	gh.commit(sha(11), [sha(4)]);
	gh.commit(sha(12), [sha(2)]);
	gh.commit(sha(13), [sha(2)]);
	gh.commit(sha(14), [sha(5)]);
	gh.pull({ number: 1, headSha: sha(11) });
	gh.pull({ number: 2, headSha: sha(12) });
	gh.pull({ number: 3, headSha: sha(13) });
	gh.pull({ number: 4, headSha: sha(14) });
	gh.status(sha(13), {
		state: 'failure',
		description: 'Merge or rebase main to include: pr-baseline',
		targetUrl: `https://github.com/acme/widgets/compare/${sha(13)}...${sha(3)}`,
	});
	gh.status(sha(14), { state: 'success', description: PASS, creator: 'someone-else' });
}

describe('refresh-pr-statuses', () => {
	it('writes only statuses that differ and reports the counts', async () => {
		const { client, github } = harness({}, populate);
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({
			openPulls: 4,
			written: 3,
			skipped: 1,
			failed: 0,
			incomplete: false,
		});
		expect(github.latestStatus(sha(11), 'PR baseline')?.state).toBe('success');
		expect(github.latestStatus(sha(12), 'PR baseline')?.state).toBe('failure');
		expect(github.latestStatus(sha(14), 'PR baseline')?.creator).toBe('github-actions[bot]');
		expect(result.entries.map((entry) => [entry.number, entry.outcome])).toEqual([
			[4, 'written'],
			[3, 'skipped'],
			[2, 'written'],
			[1, 'written'],
		]);
	});

	it('is idempotent on the second run', async () => {
		const { client, github } = harness({}, populate);
		await client.refreshPrStatuses();
		const again = await client.refreshPrStatuses();
		expect(again).toMatchObject({ written: 0, skipped: 4 });
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(3);
	});

	it('stamps every PR when the baseline is absent', async () => {
		const { client } = harness({}, (gh) => {
			gh.commit(sha(11), [sha(1)]);
			gh.pull({ number: 1, headSha: sha(11) });
		});
		const result = await client.refreshPrStatuses();
		expect(result.written).toBe(1);
		expect(result.entries[0]?.verdict?.kind).toBe('pass');
	});

	it('excludes drafts only when configured', async () => {
		const { client } = harness({ includeDrafts: false }, (gh) => {
			gh.commit(sha(11), [sha(1)]);
			gh.pull({ number: 1, headSha: sha(11), isDraft: true });
		});
		expect((await client.refreshPrStatuses()).openPulls).toBe(0);
	});

	it('logs writes in a dry run without making them', async () => {
		const { client, github, logs } = harness({ dryRun: true }, populate);
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ written: 3, dryRun: true });
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
		expect(logs.filter((line) => line.startsWith('[dry-run]'))).toHaveLength(3);
	});

	it('stops at the per-run write cap and marks the refresh incomplete', async () => {
		const { client, github } = harness({ maxWritesPerRun: 2 }, populate);
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ written: 2, incomplete: true, reason: 'write-cap' });
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(2);
	});

	it('paces writes against the per-minute cap', async () => {
		const { client, sleeps } = harness({ maxWritesPerMinute: 2 }, populate);
		const result = await client.refreshPrStatuses();
		expect(result.written).toBe(3);
		expect(sleeps).toEqual([60_000]);
	});

	it('stops when the primary budget reaches the reserve', async () => {
		const { client, github } = harness({}, (gh) => {
			populate(gh);
			gh.rateLimitRemaining = 55;
		});
		const result = await client.refreshPrStatuses();
		expect(result.incomplete).toBe(true);
		expect(result.reason).toBe('primary-budget');
		expect(github.requests(/\/statuses\//, 'POST').length).toBeLessThan(3);
	});

	it('stops on a rate limit while writing and keeps the summary', async () => {
		const { client, github } = harness({}, populate);
		github.overrides.push({
			path: /\/statuses\//,
			method: 'POST',
			status: 403,
			headers: { 'x-ratelimit-remaining': '0' },
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ written: 0, failed: 1, incomplete: true, reason: 'rate-limit' });
	});

	it('returns an incomplete summary when the listing is rate limited', async () => {
		const { client, github } = harness({}, populate);
		github.overrides.push({
			path: /graphql/,
			status: 200,
			body: { errors: [{ type: 'RATE_LIMITED' }] },
		});
		const summary = await client.refreshPrStatuses();
		expect(summary).toMatchObject({
			openPulls: 0,
			written: 0,
			incomplete: true,
			reason: 'rate-limit',
		});
	});

	it('counts the status cap as failed for that PR and continues', async () => {
		const { client, github } = harness({}, (gh) => {
			populate(gh);
			gh.overrides.push({
				path: new RegExp(`/statuses/${sha(12)}`),
				method: 'POST',
				status: 422,
				body: {
					message: 'Validation Failed',
					errors: [{ message: 'This SHA and context has reached the maximum number of statuses.' }],
				},
			});
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ written: 2, failed: 1, incomplete: true, reason: 'failed' });
		expect(result.entries.find((entry) => entry.number === 2)?.error).toContain(
			'maximum number of statuses',
		);
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(3);
	});

	it('stops after a permission error instead of failing every PR', async () => {
		const { client, github } = harness({}, populate);
		github.overrides.push({
			path: /\/statuses\//,
			method: 'POST',
			status: 403,
			times: 10,
			headers: { 'x-ratelimit-remaining': '500' },
			body: { message: 'Resource not accessible by integration' },
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ failed: 1, incomplete: true, reason: 'failed' });
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(1);
	});

	it('refuses to refresh when a baseline is not on the base branch', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.commit(sha(20), [sha(2)]);
			gh.baseline('pr-baseline', sha(20));
			gh.commit(sha(11), [sha(5)]);
			gh.pull({ number: 1, headSha: sha(11) });
		});
		await expect(client.refreshPrStatuses()).rejects.toThrow(/not an ancestor of main/);
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
	});

	it('recognises its own statuses under an App bot creator, which GraphQL names without the [bot] suffix', async () => {
		const { client, github } = harness({ creator: 'my-app[bot]' }, (gh) => {
			populate(gh);
			gh.creator = 'my-app[bot]';
			gh.status(sha(11), { state: 'success', description: PASS, creator: 'my-app[bot]' });
		});
		const result = await client.refreshPrStatuses();
		expect(result.entries.find((entry) => entry.number === 1)?.outcome).toBe('skipped');
		expect(
			github.calls.filter((call) => call.method === 'POST' && call.path.includes(sha(11))),
		).toHaveLength(0);
	});

	it('fails before evaluating anything when the creator cannot be resolved', async () => {
		const { client, github } = harness({ tokenIsWorkflowToken: false }, (gh) => {
			populate(gh);
			gh.user = null;
		});
		await expect(client.refreshPrStatuses()).rejects.toThrow(/--creator/);
		expect(github.requests(/graphql/)).toHaveLength(0);
	});

	it('pages through the listing', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.pageSize = 2;
			for (let n = 1; n <= 5; n++) {
				gh.commit(sha(20 + n), [sha(4)]);
				gh.pull({ number: n, headSha: sha(20 + n) });
			}
		});
		const result = await client.refreshPrStatuses();
		expect(result.openPulls).toBe(5);
		expect(github.requests(/graphql/)).toHaveLength(3);
	});

	it('combines scoped baselines per PR', async () => {
		const { client } = harness(
			{ baselines: [{ name: 'repo' }, { name: 'pkg-a', scope: ['packages/a/'] }] },
			(gh) => {
				gh.baseline('repo', sha(2));
				gh.baseline('pkg-a', sha(4));
				gh.commit(sha(11), [sha(3)]);
				gh.commit(sha(12), [sha(3)]);
				gh.pull({ number: 1, headSha: sha(11) });
				gh.pull({ number: 2, headSha: sha(12) });
				gh.files.set(`${sha(5)}...${sha(11)}`, ['packages/a/x.ts']);
				gh.files.set(`${sha(5)}...${sha(12)}`, ['docs/x.md']);
			},
		);
		const result = await client.refreshPrStatuses();
		const byNumber = new Map(result.entries.map((entry) => [entry.number, entry.verdict]));
		expect(byNumber.get(1)?.kind).toBe('fail');
		expect(byNumber.get(1)?.missing).toEqual(['pkg-a']);
		expect(byNumber.get(2)?.kind).toBe('pass');
		expect(byNumber.get(2)?.applicable).toEqual(['repo']);
	});
});

describe('refresh guards', () => {
	it('fails outright on the first creator mismatch instead of writing every PR', async () => {
		const { client, github } = harness({ creator: 'expected[bot]' }, populate);
		await expect(client.refreshPrStatuses()).rejects.toThrow(/expected\[bot\]/);
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(1);
	});

	it('rechecks the primary reserve after evaluation spent requests', async () => {
		const { client, github } = harness({}, (gh) => {
			populate(gh);
			// Listing and the base-membership compare bring the count to the reserve edge before the first write.
			gh.rateLimitRemaining = 55;
		});
		const result = await client.refreshPrStatuses();
		expect(result.reason).toBe('primary-budget');
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
	});

	it('returns a summary when the default-branch lookup is rate limited', async () => {
		const { client, github } = harness({}, populate);
		github.overrides.push({
			path: /^\/repos\/acme\/widgets$/,
			status: 403,
			headers: { 'x-ratelimit-remaining': '0' },
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ openPulls: 0, incomplete: true, reason: 'rate-limit' });
	});
});

describe('refresh shared heads', () => {
	it('writes a head shared by two PRs once', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(11), [sha(2)]);
			gh.pull({ number: 1, headSha: sha(11) });
			gh.pull({ number: 2, headSha: sha(11) });
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ written: 1, skipped: 1 });
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(1);
		expect(github.requests(/compare/)).toHaveLength(2);
	});

	it('keeps the resolved base in a rate-limited summary', async () => {
		const { client, github } = harness({}, populate);
		github.overrides.push({
			path: /graphql/,
			status: 200,
			body: { errors: [{ type: 'RATE_LIMITED' }] },
		});
		const result = await client.refreshPrStatuses();
		expect(result.base).toBe('main');
		expect(result.baselines[0]?.sha).toBe(sha(3));
	});
});

describe('refresh with a custom reporter', () => {
	it('asks the injected reporter for the current status instead of the listing', async () => {
		const current: string[] = [];
		const written: string[] = [];
		const { client, github } = harness(
			{
				reporter: {
					current(target) {
						current.push(target);
						return Promise.resolve({
							state: 'success',
							description: PASS,
							targetUrl: null,
							creator: 'github-actions[bot]',
						});
					},
					write(target) {
						written.push(target);
						return Promise.resolve();
					},
				},
			},
			(gh) => {
				gh.baseline('pr-baseline', sha(3));
				gh.commit(sha(11), [sha(4)]);
				gh.pull({ number: 1, headSha: sha(11) });
			},
		);
		const result = await client.refreshPrStatuses();
		expect(current).toEqual([sha(11)]);
		expect(written).toEqual([]);
		expect(result).toMatchObject({ written: 0, skipped: 1 });
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
	});
});

describe('refresh round 4', () => {
	it('records a terminal failure once for a shared head', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(11), [sha(2)]);
			gh.pull({ number: 1, headSha: sha(11) });
			gh.pull({ number: 2, headSha: sha(11) });
			gh.overrides.push({
				path: new RegExp(`/statuses/${sha(11)}`),
				method: 'POST',
				status: 422,
				body: { message: 'This SHA and context has reached the maximum number of statuses.' },
			});
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ written: 0, failed: 2, incomplete: true });
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(1);
		expect(github.requests(/compare/)).toHaveLength(2);
	});

	it('turns a rate limit from a custom reporter into an incomplete summary', async () => {
		const { client } = harness(
			{
				reporter: {
					current: () => Promise.reject(new GitHubError('rate-limit', 'custom', 'limited')),
					write: () => Promise.resolve(),
				},
			},
			(gh) => {
				gh.baseline('pr-baseline', sha(3));
				gh.commit(sha(11), [sha(4)]);
				gh.pull({ number: 1, headSha: sha(11) });
			},
		);
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ written: 0, incomplete: true, reason: 'rate-limit' });
	});

	it('binds nobody to an absent scoped baseline and matches deleted files by name', async () => {
		const { client } = harness(
			{ baselines: [{ name: 'repo' }, { name: 'pkg-a', scope: ['packages/a/'] }] },
			(gh) => {
				gh.baseline('repo', sha(2));
				gh.commit(sha(11), [sha(3)]);
				gh.pull({ number: 1, headSha: sha(11) });
				gh.files.set(`${sha(5)}...${sha(11)}`, ['packages/a/removed.ts']);
			},
		);
		const result = await client.refreshPrStatuses();
		const verdict = result.entries[0]?.verdict;
		expect(verdict?.applicable).toEqual(['repo', 'pkg-a']);
		expect(verdict?.kind).toBe('pass');
	});
});

describe('refresh write accounting', () => {
	it('counts failed writes against the per-run cap and the pacing', async () => {
		const { client, github, sleeps } = harness(
			{ maxWritesPerRun: 2, maxWritesPerMinute: 1 },
			(gh) => {
				populate(gh);
				gh.overrides.push({
					path: /\/statuses\//,
					method: 'POST',
					status: 422,
					times: 10,
					body: { message: 'This SHA and context has reached the maximum number of statuses.' },
				});
			},
		);
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ written: 0, failed: 2, incomplete: true, reason: 'write-cap' });
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(2);
		expect(sleeps).toEqual([60_000]);
	});
});

describe('refresh transport retries', () => {
	it('retries a transient write failure through the budget and succeeds', async () => {
		const { client, github } = harness({ maxWritesPerRun: 10 }, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(11), [sha(2)]);
			gh.pull({ number: 1, headSha: sha(11) });
			gh.overrides.push({ path: /\/statuses\//, method: 'POST', status: 500, times: 2 });
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ written: 1, failed: 0 });
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(3);
	});

	it('stops at the write cap in the middle of a retry sequence', async () => {
		const { client, github } = harness({ maxWritesPerRun: 2 }, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(11), [sha(2)]);
			gh.pull({ number: 1, headSha: sha(11) });
			gh.overrides.push({ path: /\/statuses\//, method: 'POST', status: 500, times: 5 });
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ written: 0, incomplete: true, reason: 'write-cap' });
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(2);
	});

	it('fails the PR after three exhausted server errors', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(11), [sha(2)]);
			gh.pull({ number: 1, headSha: sha(11) });
			gh.overrides.push({ path: /\/statuses\//, method: 'POST', status: 502, times: 5 });
		});
		const result = await client.refreshPrStatuses();
		expect(result).toMatchObject({ written: 0, failed: 1, incomplete: true });
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(3);
	});

	it('binds a PR touching two scopes to both baselines', async () => {
		const { client } = harness(
			{
				baselines: [
					{ name: 'pkg-a', scope: ['packages/a/'] },
					{ name: 'pkg-b', scope: ['packages/b/'] },
				],
			},
			(gh) => {
				gh.baseline('pkg-a', sha(4));
				gh.baseline('pkg-b', sha(2));
				gh.commit(sha(11), [sha(3)]);
				gh.pull({ number: 1, headSha: sha(11) });
				gh.files.set(`${sha(5)}...${sha(11)}`, ['packages/a/x.ts', 'packages/b/y.ts']);
			},
		);
		const result = await client.refreshPrStatuses();
		expect(result.entries[0]?.verdict).toMatchObject({
			applicable: ['pkg-a', 'pkg-b'],
			missing: ['pkg-a'],
		});
	});
});

/** An adapter that refuses any ancestry question about a commit that was not prepared for it. */
function strictAdapter(): { adapter: Ancestry; prepared: string[][] } {
	const prepared: string[][] = [];
	const known = new Set<string>();
	// The descendant of a question may be a PR head, which comes from the listing, not from `shas`.
	const guard = (commit: string): void => {
		if (prepared.length === 0) {
			throw new Error('ancestry asked before prepare');
		}
		if (!known.has(commit)) {
			throw new Error(`ancestry asked about ${commit} before it was prepared`);
		}
	};
	return {
		prepared,
		adapter: {
			name: 'api',
			isAncestor(ancestor, descendant) {
				guard(ancestor);
				return Promise.resolve(ancestor <= descendant);
			},
			changedFiles(from) {
				guard(from);
				return Promise.resolve([]);
			},
			prepare(input) {
				prepared.push(input.shas);
				for (const commit of input.shas) {
					known.add(commit);
				}
				for (const ref of input.refs) {
					if (ref.sha !== null) {
						known.add(ref.sha);
					}
				}
				return Promise.resolve({ heads: new Map() });
			},
		},
	};
}

/** A baseline at 3, one open PR containing it, and a merged labeled PR at 4. */
function orderingSetup(gh: FakeGitHub): void {
	gh.baseline('pr-baseline', sha(3));
	gh.commit(sha(11), [sha(4)]);
	gh.pull({ number: 1, headSha: sha(11) });
	gh.pull({
		number: 2,
		headSha: sha(4),
		state: 'closed',
		merged: true,
		labels: ['Require PR update'],
		mergeCommit: sha(4),
	});
}

describe('prepare ordering', () => {
	it('refresh prepares before asking', async () => {
		const strict = strictAdapter();
		const { client } = harness({ ancestryAdapter: strict.adapter }, orderingSetup);
		await expect(client.refreshPrStatuses()).resolves.toMatchObject({ written: 1 });
	});

	it('refresh-pr-status prepares before asking', async () => {
		const strict = strictAdapter();
		const { client } = harness({ ancestryAdapter: strict.adapter }, orderingSetup);
		await expect(client.refreshPrStatus({ sha: sha(11), report: true })).resolves.toMatchObject({
			verdict: { kind: 'pass' },
		});
	});

	it('report prepares before asking', async () => {
		const strict = strictAdapter();
		const { client } = harness({ ancestryAdapter: strict.adapter }, orderingSetup);
		await expect(client.report()).resolves.toMatchObject({ openPulls: 1 });
	});

	it('move-baseline prepares the target and then the labeled merge candidates', async () => {
		const strict = strictAdapter();
		const { client } = harness({ ancestryAdapter: strict.adapter }, orderingSetup);
		await expect(client.moveBaseline({ to: sha(5) })).resolves.toMatchObject({
			moves: [{ moved: true }],
		});
		expect(strict.prepared.some((shas) => shas.includes(sha(4)))).toBe(true);
	});

	it('rejects an online run without a token even with an injected adapter', () => {
		const strict = strictAdapter();
		expect(() => harness({ ancestryAdapter: strict.adapter, token: '' })).toThrow(
			/token is required/,
		);
	});
});

describe('prepare ordering after a lost race', () => {
	it('prepares the re-read baseline before asking about it', async () => {
		const strict = strictAdapter();
		const { client, github } = harness({ ancestryAdapter: strict.adapter }, (gh) =>
			gh.baseline('pr-baseline', sha(3)),
		);
		github.overrides.push({
			path: /\/git\/refs\/baselines\/pr-baseline/,
			method: 'PATCH',
			status: 422,
			body: { message: 'Update is not a fast forward' },
		});
		const original = github.fetch;
		github.fetch = async (input, init) => {
			const response = await original(input, init);
			if (response.status === 422) {
				github.baseline('pr-baseline', sha(4));
			}
			return response;
		};
		const result = await client.moveBaseline({ force: true });
		expect(result.moves[0]).toMatchObject({ moved: true, from: sha(4), to: sha(5) });
		expect(strict.prepared.some((shas) => shas.includes(sha(4)))).toBe(true);
	});
});

describe('git failures after preparation', () => {
	it('end the refresh instead of failing every PR', async () => {
		let diffs = 0;
		const adapter: Ancestry = {
			name: 'git',
			isAncestor: () => Promise.resolve(true),
			changedFiles: () => {
				diffs++;
				return Promise.reject(new GitError(['diff'], 'fatal: unable to read tree', 128));
			},
			prepare: () => Promise.resolve({ heads: new Map() }),
		};
		const { client, github } = harness(
			{ ancestryAdapter: adapter, baselines: [{ name: 'pr-baseline', scope: ['packages/a/'] }] },
			(gh) => {
				gh.baseline('pr-baseline', sha(3));
				gh.commit(sha(11), [sha(2)]);
				gh.commit(sha(12), [sha(2)]);
				gh.pull({ number: 1, headSha: sha(11) });
				gh.pull({ number: 2, headSha: sha(12) });
			},
		);
		await expect(client.refreshPrStatuses()).rejects.toThrow(/unable to read tree/);
		expect(diffs).toBe(1);
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
	});
});
