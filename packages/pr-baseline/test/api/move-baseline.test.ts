import { describe, expect, it } from 'vitest';
import { harness, sha } from '../helpers/client.ts';

describe('move-baseline', () => {
	it('seeds an absent tag only when forced', async () => {
		const { client, github } = harness();
		const quiet = await client.moveBaseline();
		expect(quiet.moves[0]).toMatchObject({
			moved: false,
			from: null,
			note: expect.stringContaining('--force'),
		});
		expect(github.tags.has('pr-baseline')).toBe(false);
		const forced = await client.moveBaseline({ force: true });
		expect(forced.moves[0]).toMatchObject({
			moved: true,
			from: null,
			to: sha(5),
			reason: 'forced',
		});
		expect(github.tags.get('pr-baseline')?.peeled).toBe(sha(5));
	});

	it('does nothing without intent and reports why', async () => {
		const { client, github } = harness({}, (gh) => gh.tag('pr-baseline', sha(3)));
		const result = await client.moveBaseline();
		expect(result.moves[0]).toMatchObject({
			moved: false,
			from: sha(3),
			note: expect.stringContaining('no labeled merge'),
		});
		expect(github.requests(/\/git\/refs\//, 'PATCH')).toHaveLength(0);
	});

	it('moves on a labeled merge that landed after the baseline, without any date logic', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.tag('pr-baseline', sha(3));
			gh.pull({
				number: 1,
				headSha: sha(2),
				state: 'closed',
				merged: true,
				labels: ['Require PR update'],
				mergeCommit: sha(2),
			});
			gh.pull({
				number: 2,
				headSha: sha(4),
				state: 'closed',
				merged: true,
				labels: ['Require PR update'],
				mergeCommit: sha(4),
			});
			gh.pull({
				number: 3,
				headSha: sha(4),
				state: 'closed',
				merged: true,
				labels: ['Other'],
				mergeCommit: sha(5),
			});
		});
		const result = await client.moveBaseline();
		expect(result.moves[0]).toMatchObject({
			moved: true,
			from: sha(3),
			to: sha(5),
			reason: 'label',
		});
		expect(github.tags.get('pr-baseline')?.peeled).toBe(sha(5));
		const patch = github.requests(/\/git\/refs\/tags\/pr-baseline/, 'PATCH')[0];
		expect(patch?.body).toEqual({ sha: sha(5), force: false });
	});

	it('moves on a marker change since the baseline', async () => {
		const { client } = harness(
			{ baselines: [{ tag: 'pr-baseline', markers: ['.nvmrc'] }] },
			(gh) => {
				gh.tag('pr-baseline', sha(3));
				gh.files.set(`${sha(3)}...${sha(5)}`, ['src/a.ts', '.nvmrc']);
			},
		);
		const result = await client.moveBaseline();
		expect(result.moves[0]).toMatchObject({ moved: true, reason: 'markers' });
	});

	it('does not move automatically when the marker diff is indeterminate', async () => {
		const { client } = harness(
			{ baselines: [{ tag: 'pr-baseline', markers: ['.nvmrc'] }] },
			(gh) => {
				gh.tag('pr-baseline', sha(3));
				gh.files.set(
					`${sha(3)}...${sha(5)}`,
					Array.from({ length: 300 }, (_, i) => `f${i}`),
				);
			},
		);
		const result = await client.moveBaseline();
		expect(result.moves[0]).toMatchObject({
			moved: false,
			note: expect.stringContaining('indeterminate'),
		});
	});

	it('reports a baseline already at the target and still sweeps', async () => {
		const { client } = harness({}, (gh) => {
			gh.tag('pr-baseline', sha(5));
			gh.commit(sha(11), [sha(4)]);
			gh.pull({ number: 1, headSha: sha(11) });
		});
		const result = await client.moveBaseline({ force: true, sweep: true });
		expect(result.moves[0]).toMatchObject({ moved: false, note: 'already at the target' });
		expect(result.sweep).toMatchObject({ written: 1 });
	});

	it('refuses a target that does not descend from the current baseline', async () => {
		const { client } = harness({}, (gh) => {
			gh.commit(sha(20), [sha(2)]);
			gh.tag('pr-baseline', sha(20));
		});
		await expect(client.moveBaseline({ force: true })).rejects.toThrow(/does not descend/);
	});

	it('honors --to when the target is on the base branch, and rejects it otherwise', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.tag('pr-baseline', sha(2));
			gh.commit(sha(20), [sha(2)]);
		});
		const result = await client.moveBaseline({ force: true, to: sha(4) });
		expect(result.moves[0]).toMatchObject({ moved: true, to: sha(4) });
		expect(github.tags.get('pr-baseline')?.peeled).toBe(sha(4));
		await expect(client.moveBaseline({ force: true, to: sha(20) })).rejects.toThrow(/not on main/);
	});

	it('restricts to one baseline and rejects an unknown tag', async () => {
		const { client, github } = harness({ baselines: [{ tag: 'a' }, { tag: 'b' }] });
		const result = await client.moveBaseline({ force: true, baseline: 'b' });
		expect(result.moves.map((move) => move.tag)).toEqual(['b']);
		expect(github.tags.has('a')).toBe(false);
		await expect(client.moveBaseline({ baseline: 'zzz' })).rejects.toThrow(
			/No configured baseline/,
		);
	});

	it('scans each label once and fans a shared label out to every baseline carrying it', async () => {
		const { client, github } = harness(
			{
				baselines: [
					{ tag: 'one', label: 'Shared' },
					{ tag: 'two', label: 'Shared' },
					{ tag: 'three', label: 'Other' },
				],
			},
			(gh) => {
				gh.tag('one', sha(2));
				gh.tag('two', sha(3));
				gh.tag('three', sha(3));
				gh.pull({
					number: 1,
					headSha: sha(4),
					state: 'closed',
					merged: true,
					labels: ['Shared'],
					mergeCommit: sha(4),
				});
			},
		);
		const result = await client.moveBaseline();
		expect(result.moves.map((move) => [move.tag, move.moved])).toEqual([
			['one', true],
			['two', true],
			['three', false],
		]);
		expect(github.requests(/graphql/)).toHaveLength(2);
	});

	it('re-evaluates once when another writer moved the tag first', async () => {
		const { client, github, warnings } = harness({}, (gh) => gh.tag('pr-baseline', sha(3)));
		github.overrides.push({
			path: /\/git\/refs\/tags\/pr-baseline/,
			method: 'PATCH',
			status: 422,
			body: { message: 'Update is not a fast forward' },
		});
		const original = github.fetch;
		github.fetch = async (input, init) => {
			// The rejected PATCH is followed by a re-read that finds the tag moved by someone else.
			const response = await original(input, init);
			if (response.status === 422) {
				github.tag('pr-baseline', sha(4));
			}
			return response;
		};
		const result = await client.moveBaseline({ force: true });
		expect(result.moves[0]).toMatchObject({ moved: true, from: sha(4), to: sha(5) });
		expect(warnings.join('\n')).toContain('re-evaluating once');
	});

	it('settles when the other writer already reached the target', async () => {
		const { client, github } = harness({}, (gh) => gh.tag('pr-baseline', sha(3)));
		github.overrides.push({ path: /\/git\/refs\/tags\/pr-baseline/, method: 'PATCH', status: 409 });
		const original = github.fetch;
		github.fetch = async (input, init) => {
			const response = await original(input, init);
			if (response.status === 409) {
				github.tag('pr-baseline', sha(5));
			}
			return response;
		};
		const result = await client.moveBaseline({ force: true });
		expect(result.moves[0]).toMatchObject({
			moved: false,
			from: sha(5),
			note: 'already at the target',
		});
		expect(result.baselines[0]?.sha).toBe(sha(5));
	});

	it('treats a rejection with an unmoved tag as terminal', async () => {
		const { client, github } = harness({}, (gh) => gh.tag('pr-baseline', sha(3)));
		github.overrides.push({
			path: /\/git\/refs\/tags\/pr-baseline/,
			method: 'PATCH',
			status: 422,
			body: { message: 'Update is not a fast forward' },
		});
		await expect(client.moveBaseline({ force: true })).rejects.toMatchObject({
			kind: 'validation',
		});
	});

	it('gives up with a retry hint after a second race', async () => {
		const { client, github } = harness({}, (gh) => gh.tag('pr-baseline', sha(2)));
		github.overrides.push({
			path: /\/git\/refs\/tags\/pr-baseline/,
			method: 'PATCH',
			status: 409,
			times: 2,
		});
		let bumps = 3;
		const original = github.fetch;
		github.fetch = async (input, init) => {
			const response = await original(input, init);
			if (response.status === 409) {
				github.tag('pr-baseline', sha(bumps++));
			}
			return response;
		};
		await expect(client.moveBaseline({ force: true })).rejects.toThrow(/moved twice/);
	});

	it('runs the sweep against the intended baselines in a dry run', async () => {
		const { client, github } = harness({ dryRun: true }, (gh) => {
			gh.commit(sha(11), [sha(4)]);
			gh.pull({ number: 1, headSha: sha(11) });
		});
		const result = await client.moveBaseline({ force: true, sweep: true });
		expect(result.moves[0]).toMatchObject({ moved: true, to: sha(5) });
		expect(github.tags.has('pr-baseline')).toBe(false);
		expect(result.sweep?.baselines[0]?.sha).toBe(sha(5));
		expect(result.sweep?.entries[0]?.verdict?.kind).toBe('fail');
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
	});

	it('resolves the creator before moving when a sweep follows', async () => {
		const { client, github } = harness({ tokenIsWorkflowToken: false }, (gh) => {
			gh.user = null;
		});
		await expect(client.moveBaseline({ force: true, sweep: true })).rejects.toThrow(/--creator/);
		expect(github.tags.has('pr-baseline')).toBe(false);
	});
});

describe('move-baseline races and paging', () => {
	it('pages through the labeled merge scan', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.tag('pr-baseline', sha(3));
			gh.pageSize = 2;
			for (let n = 1; n <= 5; n++) {
				gh.pull({
					number: n,
					headSha: sha(2),
					state: 'closed',
					merged: true,
					labels: ['Require PR update'],
					mergeCommit: sha(2),
				});
			}
		});
		const result = await client.moveBaseline();
		expect(result.moves[0]?.moved).toBe(false);
		expect(github.requests(/graphql/)).toHaveLength(3);
	});

	it('treats a 409 with an unmoved tag as terminal', async () => {
		const { client, github } = harness({}, (gh) => gh.tag('pr-baseline', sha(3)));
		github.overrides.push({ path: /\/git\/refs\/tags\/pr-baseline/, method: 'PATCH', status: 409 });
		await expect(client.moveBaseline({ force: true })).rejects.toMatchObject({ kind: 'conflict' });
	});

	it('re-evaluates when a seed loses the race to another writer', async () => {
		const { client, github } = harness();
		github.overrides.push({
			path: /\/git\/refs$/,
			method: 'POST',
			status: 422,
			body: { message: 'Reference already exists' },
		});
		const original = github.fetch;
		github.fetch = async (input, init) => {
			const response = await original(input, init);
			if (response.status === 422) {
				github.tag('pr-baseline', sha(4));
			}
			return response;
		};
		const result = await client.moveBaseline({ force: true });
		expect(result.moves[0]).toMatchObject({ moved: true, from: sha(4), to: sha(5) });
		expect(result.baselines[0]?.sha).toBe(sha(5));
	});
});

describe('move-baseline label scan', () => {
	it('skips the label scan for a forced move and for a baseline already at the target', async () => {
		const { client, github } = harness({}, (gh) => gh.tag('pr-baseline', sha(3)));
		await client.moveBaseline({ force: true });
		expect(github.requests(/graphql/)).toHaveLength(0);
		await client.moveBaseline();
		expect(github.requests(/graphql/)).toHaveLength(0);
	});
});

describe('move-baseline validation order', () => {
	it('rejects an unknown selector before any request', async () => {
		const { client, github } = harness();
		await expect(client.moveBaseline({ baseline: 'zzz' })).rejects.toThrow(
			/No configured baseline/,
		);
		expect(github.calls).toHaveLength(0);
	});
});

describe('move-baseline after a successful move', () => {
	it('re-reads the tags so a writer that advanced them afterwards is not undone by the sweep', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.tag('pr-baseline', sha(3));
			gh.commit(sha(11), [sha(5)]);
			gh.pull({ number: 1, headSha: sha(11) });
		});
		const original = github.fetch;
		github.fetch = async (input, init) => {
			const response = await original(input, init);
			// Right after this run's PATCH lands, another writer pushes commit 6 and moves the tag there.
			if ((init?.method ?? '').toUpperCase() === 'PATCH' && response.status === 200) {
				github.commit(sha(6), [sha(5)]);
				github.branch('main', sha(6));
				github.tag('pr-baseline', sha(6));
			}
			return response;
		};
		const result = await client.moveBaseline({ force: true, sweep: true });
		expect(result.moves[0]).toMatchObject({ moved: true, to: sha(5) });
		expect(result.baselines[0]?.sha).toBe(sha(6));
		expect(result.sweep?.entries[0]?.verdict?.kind).toBe('fail');
		expect(github.latestStatus(sha(11), 'PR baseline')?.state).toBe('failure');
	});
});

describe('move-baseline with a tag named @', () => {
	it('reads, seeds and fast-forwards it through the encoded route', async () => {
		const { client, github } = harness({ baselines: [{ tag: '@' }] });
		await client.moveBaseline({ force: true, to: sha(4) });
		expect(github.tags.get('@')?.peeled).toBe(sha(4));
		const result = await client.moveBaseline({ force: true });
		expect(result.moves[0]).toMatchObject({ moved: true, from: sha(4), to: sha(5) });
		expect(github.calls.some((call) => call.rawPath.endsWith('/git/refs/tags%2F%40'))).toBe(true);
	});
});

describe('move-baseline with two labels', () => {
	it('moves each baseline on its own label independently', async () => {
		const { client, github } = harness(
			{
				baselines: [
					{ tag: 'one', label: 'Label One' },
					{ tag: 'two', label: 'Label Two' },
				],
			},
			(gh) => {
				gh.tag('one', sha(2));
				gh.tag('two', sha(2));
				gh.pull({
					number: 1,
					headSha: sha(3),
					state: 'closed',
					merged: true,
					labels: ['Label One'],
					mergeCommit: sha(3),
				});
				gh.pull({
					number: 2,
					headSha: sha(4),
					state: 'closed',
					merged: true,
					labels: ['Label Two'],
					mergeCommit: sha(4),
				});
			},
		);
		const result = await client.moveBaseline();
		expect(result.moves.map((move) => [move.tag, move.moved, move.reason])).toEqual([
			['one', true, 'label'],
			['two', true, 'label'],
		]);
		expect(github.requests(/graphql/)).toHaveLength(2);
	});
});
