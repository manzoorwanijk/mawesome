import { describe, expect, it } from 'vitest';
import { harness, sha } from '../helpers/client.ts';

describe('move-baseline', () => {
	it('seeds an absent baseline only when forced', async () => {
		const { client, github } = harness();
		const quiet = await client.moveBaseline();
		expect(quiet.moves[0]).toMatchObject({
			moved: false,
			from: null,
			note: expect.stringContaining('--force'),
		});
		expect(github.hasBaseline('pr-baseline')).toBe(false);
		const forced = await client.moveBaseline({ force: true });
		expect(forced.moves[0]).toMatchObject({
			moved: true,
			from: null,
			to: sha(5),
			reason: 'forced',
		});
		expect(github.baselineAt('pr-baseline')).toBe(sha(5));
	});

	it('does nothing without intent and reports why', async () => {
		const { client, github } = harness({}, (gh) => gh.baseline('pr-baseline', sha(3)));
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
			gh.baseline('pr-baseline', sha(3));
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
		expect(github.baselineAt('pr-baseline')).toBe(sha(5));
		const patch = github.requests(/\/git\/refs\/baselines\/pr-baseline/, 'PATCH')[0];
		expect(patch?.body).toEqual({ sha: sha(5), force: false });
	});

	it('moves on a marker change since the baseline', async () => {
		const { client } = harness(
			{ baselines: [{ name: 'pr-baseline', markers: ['.nvmrc'] }] },
			(gh) => {
				gh.baseline('pr-baseline', sha(3));
				gh.files.set(`${sha(3)}...${sha(5)}`, ['src/a.ts', '.nvmrc']);
			},
		);
		const result = await client.moveBaseline();
		expect(result.moves[0]).toMatchObject({ moved: true, reason: 'markers' });
	});

	it('does not move automatically when the marker diff is indeterminate', async () => {
		const { client } = harness(
			{ baselines: [{ name: 'pr-baseline', markers: ['.nvmrc'] }] },
			(gh) => {
				gh.baseline('pr-baseline', sha(3));
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

	it('reports a baseline already at the target and still refreshes', async () => {
		const { client } = harness({ scope: 'all' }, (gh) => {
			gh.baseline('pr-baseline', sha(5));
			gh.commit(sha(11), [sha(4)]);
			gh.pull({ number: 1, headSha: sha(11) });
		});
		const result = await client.moveBaseline({ force: true, refreshPrStatuses: true });
		expect(result.moves[0]).toMatchObject({ moved: false, note: 'already at the target' });
		expect(result.refresh).toMatchObject({ written: 1 });
	});

	it('keeps the default scope when a forced move moved nothing', async () => {
		const { client } = harness({ scope: undefined }, (gh) => {
			gh.baseline('pr-baseline', sha(5));
			gh.commit(sha(11), [sha(4)]);
			gh.pull({ number: 1, headSha: sha(11) });
		});
		const result = await client.moveBaseline({ force: true, refreshPrStatuses: true });
		// Nothing moved, so nothing can have turned red into green; the full sweep is not owed.
		expect(result.refresh).toMatchObject({ scope: 'corrections' });
	});

	it('refuses a rewind to an older commit on the base branch', async () => {
		const { client } = harness({}, (gh) => gh.baseline('pr-baseline', sha(5)));
		await expect(client.moveBaseline({ force: true, to: sha(3) })).rejects.toThrow(
			/does not descend/,
		);
	});

	it('reports a baseline that left the base branch, and repairs it when forced', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.commit(sha(20), [sha(2)]);
			gh.baseline('pr-baseline', sha(20));
		});
		const quiet = await client.moveBaseline();
		expect(quiet.moves[0]).toMatchObject({
			moved: false,
			from: sha(20),
			note: expect.stringContaining('not on the base branch'),
		});
		expect(github.baselineAt('pr-baseline')).toBe(sha(20));
		const forced = await client.moveBaseline({ force: true });
		expect(forced.moves[0]).toMatchObject({ moved: true, from: sha(20), to: sha(5) });
		expect(github.baselineAt('pr-baseline')).toBe(sha(5));
	});

	it('honors --to when the target is on the base branch, and rejects it otherwise', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(2));
			gh.commit(sha(20), [sha(2)]);
		});
		const result = await client.moveBaseline({ force: true, to: sha(4) });
		expect(result.moves[0]).toMatchObject({ moved: true, to: sha(4) });
		expect(github.baselineAt('pr-baseline')).toBe(sha(4));
		await expect(client.moveBaseline({ force: true, to: sha(20) })).rejects.toThrow(/not on main/);
	});

	it('restricts to one baseline and rejects an unknown name', async () => {
		const { client, github } = harness({ baselines: [{ name: 'a' }, { name: 'b' }] });
		const result = await client.moveBaseline({ force: true, baseline: 'b' });
		expect(result.moves.map((move) => move.name)).toEqual(['b']);
		expect(github.hasBaseline('a')).toBe(false);
		await expect(client.moveBaseline({ baseline: 'zzz' })).rejects.toThrow(
			/No configured baseline/,
		);
	});

	it('scans each label once and fans a shared label out to every baseline carrying it', async () => {
		const { client, github } = harness(
			{
				baselines: [
					{ name: 'one', label: 'Shared' },
					{ name: 'two', label: 'Shared' },
					{ name: 'three', label: 'Other' },
				],
			},
			(gh) => {
				gh.baseline('one', sha(2));
				gh.baseline('two', sha(3));
				gh.baseline('three', sha(3));
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
		expect(result.moves.map((move) => [move.name, move.moved])).toEqual([
			['one', true],
			['two', true],
			['three', false],
		]);
		expect(github.requests(/graphql/)).toHaveLength(2);
	});

	it('re-applies its move once when another writer crossed it', async () => {
		const { client, github, warnings } = harness({}, (gh) => gh.baseline('pr-baseline', sha(3)));
		let crossed = false;
		// The refs API enforces no fast-forward here, so the other writer's rewind lands right after this run's write.
		github.onRefWrite = (_ref, target) => {
			if (!crossed && target === sha(5)) {
				crossed = true;
				github.baseline('pr-baseline', sha(4));
			}
		};
		const result = await client.moveBaseline({ force: true });
		expect(result.moves[0]).toMatchObject({ moved: true, from: sha(4), to: sha(5) });
		expect(result.baselines[0]?.sha).toBe(sha(5));
		expect(github.requests(/\/git\/refs\/baselines\/pr-baseline/, 'PATCH')).toHaveLength(2);
		expect(warnings.join('\n')).toContain('re-evaluating once');
	});

	it('leaves a baseline another writer moved past the target', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(6), [sha(5)]);
		});
		let crossed = false;
		github.onRefWrite = (_ref, target) => {
			if (!crossed && target === sha(5)) {
				crossed = true;
				github.baseline('pr-baseline', sha(6));
			}
		};
		const result = await client.moveBaseline({ force: true });
		expect(result.moves[0]).toMatchObject({
			moved: false,
			from: sha(6),
			to: sha(5),
			note: 'another writer moved it past the target',
		});
		expect(result.baselines[0]?.sha).toBe(sha(6));
	});

	it('treats a rejection with an unmoved baseline as terminal', async () => {
		const { client, github } = harness({}, (gh) => gh.baseline('pr-baseline', sha(3)));
		github.overrides.push({
			path: /\/git\/refs\/baselines\/pr-baseline/,
			method: 'PATCH',
			status: 422,
			body: { message: 'Update is not a fast forward' },
		});
		await expect(client.moveBaseline({ force: true })).rejects.toMatchObject({
			kind: 'validation',
		});
	});

	it('gives up with a retry hint after a second race', async () => {
		const { client, github } = harness({}, (gh) => gh.baseline('pr-baseline', sha(2)));
		let bumps = 3;
		github.onRefWrite = (_ref, target) => {
			if (target === sha(5)) {
				github.baseline('pr-baseline', sha(bumps++));
			}
		};
		await expect(client.moveBaseline({ force: true })).rejects.toThrow(/moved twice/);
	});

	it('runs the refresh against the intended baselines in a dry run', async () => {
		const { client, github } = harness({ dryRun: true }, (gh) => {
			gh.commit(sha(11), [sha(4)]);
			gh.pull({ number: 1, headSha: sha(11) });
		});
		const result = await client.moveBaseline({ force: true, refreshPrStatuses: true });
		expect(result.moves[0]).toMatchObject({ moved: true, to: sha(5) });
		expect(github.hasBaseline('pr-baseline')).toBe(false);
		expect(result.refresh?.baselines[0]?.sha).toBe(sha(5));
		expect(result.refresh?.entries[0]?.verdict?.kind).toBe('fail');
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
	});

	it('resolves the creator before moving when a refresh follows', async () => {
		const { client, github } = harness({ tokenIsWorkflowToken: false }, (gh) => {
			gh.user = null;
		});
		await expect(client.moveBaseline({ force: true, refreshPrStatuses: true })).rejects.toThrow(
			/--creator/,
		);
		expect(github.hasBaseline('pr-baseline')).toBe(false);
	});
});

describe('move-baseline races and paging', () => {
	it('pages through the labeled merge scan', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
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

	it('treats a 409 with an unmoved baseline as terminal', async () => {
		const { client, github } = harness({}, (gh) => gh.baseline('pr-baseline', sha(3)));
		github.overrides.push({
			path: /\/git\/refs\/baselines\/pr-baseline/,
			method: 'PATCH',
			status: 409,
		});
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
				github.baseline('pr-baseline', sha(4));
			}
			return response;
		};
		const result = await client.moveBaseline({ force: true });
		expect(result.moves[0]).toMatchObject({ moved: true, from: sha(4), to: sha(5), via: 'api' });
		expect(result.baselines[0]?.sha).toBe(sha(5));
	});

	it('cannot see a forward move that lands just before its own write, which is why git leases come first', async () => {
		const { client, github, warnings } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(6), [sha(5)]);
		});
		const original = github.fetch;
		github.fetch = async (input, init) => {
			if (
				(init?.method ?? '').toUpperCase() === 'PATCH' &&
				github.baselineAt('pr-baseline') === sha(3)
			) {
				github.baseline('pr-baseline', sha(6));
			}
			return original(input, init);
		};
		const result = await client.moveBaseline({ force: true });
		expect(result.moves[0]).toMatchObject({ moved: true, from: sha(3), to: sha(5), via: 'api' });
		expect(github.baselineAt('pr-baseline')).toBe(sha(5));
		expect(warnings.join('\n')).not.toContain('trying the next way');
	});
});

describe('move-baseline label scan', () => {
	it('skips the label scan for a forced move and for a baseline already at the target', async () => {
		const { client, github } = harness({}, (gh) => gh.baseline('pr-baseline', sha(3)));
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
	it('re-reads the baseline refs so a writer that advanced them afterwards is not undone by the refresh', async () => {
		const { client, github } = harness({}, (gh) => {
			gh.baseline('pr-baseline', sha(3));
			gh.commit(sha(11), [sha(5)]);
			gh.pull({ number: 1, headSha: sha(11) });
		});
		const original = github.fetch;
		github.fetch = async (input, init) => {
			const response = await original(input, init);
			// Right after this run's PATCH lands, another writer pushes commit 6 and moves the ref there.
			if ((init?.method ?? '').toUpperCase() === 'PATCH' && response.status === 200) {
				github.commit(sha(6), [sha(5)]);
				github.branch('main', sha(6));
				github.baseline('pr-baseline', sha(6));
			}
			return response;
		};
		const result = await client.moveBaseline({ force: true, refreshPrStatuses: true });
		expect(result.moves[0]).toMatchObject({ moved: false, from: sha(6), to: sha(5) });
		expect(result.baselines[0]?.sha).toBe(sha(6));
		expect(result.refresh?.entries[0]?.verdict?.kind).toBe('fail');
		expect(github.latestStatus(sha(11), 'PR baseline')?.state).toBe('failure');
	});
});

describe('move-baseline with a baseline named @', () => {
	it('reads, seeds and fast-forwards it through the encoded route', async () => {
		const { client, github } = harness({ baselines: [{ name: '@' }] });
		await client.moveBaseline({ force: true, to: sha(4) });
		expect(github.baselineAt('@')).toBe(sha(4));
		const result = await client.moveBaseline({ force: true });
		expect(result.moves[0]).toMatchObject({ moved: true, from: sha(4), to: sha(5) });
		expect(github.calls.some((call) => call.rawPath.endsWith('/git/refs/baselines%2F%40'))).toBe(
			true,
		);
	});
});

describe('move-baseline with two labels', () => {
	it('moves each baseline on its own label independently', async () => {
		const { client, github } = harness(
			{
				baselines: [
					{ name: 'one', label: 'Label One' },
					{ name: 'two', label: 'Label Two' },
				],
			},
			(gh) => {
				gh.baseline('one', sha(2));
				gh.baseline('two', sha(2));
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
		expect(result.moves.map((move) => [move.name, move.moved, move.reason])).toEqual([
			['one', true, 'label'],
			['two', true, 'label'],
		]);
		expect(github.requests(/graphql/)).toHaveLength(2);
	});
});

describe('move-baseline races, round 7', () => {
	it('uses the base head it read as the default target even when the base advances meanwhile', async () => {
		const { client, github } = harness({}, (gh) => gh.baseline('pr-baseline', sha(3)));
		let reads = 0;
		const original = github.fetch;
		github.fetch = async (input, init) => {
			const response = await original(input, init);
			const url = String(input instanceof Request ? input.url : input);
			if (url.endsWith('/commits/main') && ++reads === 1) {
				github.commit(sha(6), [sha(5)]);
				github.branch('main', sha(6));
			}
			return response;
		};
		const result = await client.moveBaseline({ force: true });
		expect(result.moves[0]).toMatchObject({ moved: true, to: sha(5) });
	});
});
