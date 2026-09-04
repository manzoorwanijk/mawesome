import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { boundedSummary, run } from '../../action/src/run.ts';
import type { RefreshPrStatusesResult } from '../../src/index.ts';
import { FakeGitHub, sha } from '../helpers/fake-github.ts';

interface World {
	dir: string;
	github: FakeGitHub;
	saved: NodeJS.ProcessEnv;
	savedFetch: typeof fetch;
}

let world: World;
// One directory for the whole file: @actions/core resolves the summary path once and keeps it.
const dir = mkdtempSync(join(tmpdir(), 'pr-baseline-action-'));

/** The runner's contract: inputs as `INPUT_*`, the event on disk, outputs and the summary appended to files. */
function runner(input: {
	event: string;
	payload: Record<string, unknown>;
	inputs?: Record<string, string>;
	actor?: string;
}): void {
	const eventPath = join(world.dir, 'event.json');
	writeFileSync(eventPath, JSON.stringify(input.payload));
	for (const name of Object.keys(process.env)) {
		if (name.startsWith('INPUT_') || name.startsWith('GITHUB_') || name === 'RUNNER_TEMP') {
			delete process.env[name];
		}
	}
	Object.assign(process.env, {
		GITHUB_EVENT_NAME: input.event,
		GITHUB_EVENT_PATH: eventPath,
		GITHUB_REPOSITORY: world.github.repo,
		GITHUB_API_URL: 'https://api.github.com',
		GITHUB_GRAPHQL_URL: 'https://api.github.com/graphql',
		GITHUB_SERVER_URL: 'https://github.com',
		GITHUB_OUTPUT: join(world.dir, 'output.txt'),
		GITHUB_STEP_SUMMARY: join(world.dir, 'summary.md'),
		RUNNER_TEMP: world.dir,
		INPUT_TOKEN: 'workflow-token',
		'INPUT_GITHUB-TOKEN-PROBE': 'workflow-token',
		GITHUB_ACTOR: input.actor ?? 'octocat',
	});
	writeFileSync(process.env['GITHUB_OUTPUT'] as string, '');
	writeFileSync(process.env['GITHUB_STEP_SUMMARY'] as string, '');
	for (const [name, value] of Object.entries(input.inputs ?? {})) {
		process.env[`INPUT_${name.toUpperCase()}`] = value;
	}
}

/** Parses the `name<<delim\nvalue\ndelim` records @actions/core appends to GITHUB_OUTPUT. */
function outputs(): Record<string, string> {
	const text = readFileSync(process.env['GITHUB_OUTPUT'] as string, 'utf8');
	const result: Record<string, string> = {};
	const pattern = /^([^\n<]+)<<(\S+)\n([\s\S]*?)\n\2$/gm;
	for (const match of text.matchAll(pattern)) {
		result[match[1] as string] = match[3] as string;
	}
	return result;
}

function summary(): string {
	return readFileSync(process.env['GITHUB_STEP_SUMMARY'] as string, 'utf8');
}

const OUTPUT_NAMES = [
	'base',
	'baselines',
	'closed',
	'deferred',
	'description',
	'failed',
	'incomplete',
	'missing',
	'results-file',
	'skipped',
	'state',
	'summary',
	'written',
];

/** Every path sets the complete output schema. */
function allOutputs(): Record<string, string> {
	const out = outputs();
	expect(Object.keys(out).toSorted()).toEqual(OUTPUT_NAMES);
	return out;
}

beforeEach(() => {
	const github = new FakeGitHub();
	github.chain(1, 5);
	github.branch('main', sha(5));
	github.tag('pr-baseline', sha(3));
	github.commit(sha(11), [sha(4)]);
	github.commit(sha(12), [sha(2)]);
	world = {
		dir,
		github,
		saved: { ...process.env },
		savedFetch: globalThis.fetch,
	};
	globalThis.fetch = (input, init) => github.fetch(input, init);
});

afterEach(() => {
	globalThis.fetch = world.savedFetch;
	for (const name of Object.keys(process.env)) {
		delete process.env[name];
	}
	Object.assign(process.env, world.saved);
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});
beforeAll(() => undefined);

const pullPayload = (
	head: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
	action: 'synchronize',
	repository: { full_name: 'acme/widgets' },
	pull_request: {
		number: 1,
		head: { sha: head, repo: { full_name: 'acme/widgets', fork: false } },
		base: { ref: 'main' },
		merged: false,
	},
	...extra,
});

describe('action mode: auto', () => {
	it('refreshes the status and writes on pull_request_target', async () => {
		runner({ event: 'pull_request_target', payload: pullPayload(sha(12)) });
		await run();
		const out = allOutputs();
		expect(out['state']).toBe('failure');
		expect(JSON.parse(out['missing'] as string)).toEqual(['pr-baseline']);
		expect(out['written']).toBe('1');
		expect(world.github.latestStatus(sha(12), 'PR baseline')?.creator).toBe('github-actions[bot]');
		expect(summary()).toContain('PR baseline status');
		expect(process.exitCode ?? 0).toBe(0);
	});

	it('moves and refreshes on a merged pull_request_target', async () => {
		world.github.pull({ number: 1, headSha: sha(11) });
		world.github.pull({
			number: 2,
			headSha: sha(4),
			state: 'closed',
			merged: true,
			labels: ['Require PR update'],
			mergeCommit: sha(4),
		});
		runner({
			event: 'pull_request_target',
			payload: pullPayload(sha(4), {
				action: 'closed',
				pull_request: { ...(pullPayload(sha(4))['pull_request'] as object), merged: true },
			}),
		});
		await run();
		const out = allOutputs();
		expect(world.github.tags.get('pr-baseline')?.peeled).toBe(sha(5));
		expect(out['written']).toBe('1');
		expect(out['incomplete']).toBe('false');
		expect(out['results-file']).toContain('pr-baseline-refresh');
		const parsed = JSON.parse(out['summary'] as string) as { moves: { moved: boolean }[] };
		expect(parsed.moves.filter((move) => move.moved)).toHaveLength(1);
	});

	it('evaluates without writing and skips moves when Dependabot triggered the run', async () => {
		runner({
			event: 'pull_request_target',
			payload: pullPayload(sha(12)),
			actor: 'dependabot[bot]',
		});
		await run();
		expect(outputs()['state']).toBe('failure');
		expect(outputs()['written']).toBe('0');
		const closed = pullPayload(sha(4), {
			action: 'closed',
			pull_request: { ...(pullPayload(sha(4))['pull_request'] as object), merged: true },
		});
		runner({ event: 'pull_request_target', payload: closed, actor: 'dependabot[bot]' });
		await run();
		expect(outputs()['state']).toBe('skipped');
		runner({
			event: 'push',
			payload: { ref: 'refs/heads/main', repository: { default_branch: 'main' } },
			actor: 'dependabot[bot]',
		});
		await run();
		expect(outputs()['state']).toBe('skipped');
		runner({
			event: 'merge_group',
			payload: { merge_group: { head_sha: sha(11), base_ref: 'refs/heads/main' } },
			actor: 'dependabot[bot]',
		});
		await run();
		expect(outputs()['state']).toBe('success');
		expect(outputs()['written']).toBe('0');
		runner({
			event: 'workflow_dispatch',
			payload: {},
			inputs: { mode: 'refresh-pr-statuses' },
			actor: 'dependabot[bot]',
		});
		await run();
		expect(outputs()['state']).toBe('skipped');
		runner({
			event: 'workflow_dispatch',
			payload: {},
			inputs: { mode: 'report' },
			actor: 'dependabot[bot]',
		});
		await run();
		expect(outputs()['state']).toBe('success');
		expect(world.github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
		world.github.creator = 'octocat';
		runner({
			event: 'workflow_dispatch',
			payload: {},
			actor: 'dependabot[bot]',
			inputs: { mode: 'refresh-pr-status', sha: sha(12), token: 'app-token', creator: 'octocat' },
		});
		await run();
		expect(outputs()['written']).toBe('1');
		expect(world.github.requests(/\/statuses\//, 'POST')).toHaveLength(1);
	});

	it('does nothing on a closed, unmerged pull_request_target', async () => {
		runner({ event: 'pull_request_target', payload: pullPayload(sha(12), { action: 'closed' }) });
		await run();
		expect(outputs()['state']).toBe('skipped');
		expect(world.github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
	});

	it('evaluates without writing on a pull_request from a fork, and writes with a custom token', async () => {
		const payload = pullPayload(sha(12));
		(payload['pull_request'] as { head: { repo: { full_name: string } } }).head.repo = {
			full_name: 'someone/widgets',
		};
		runner({ event: 'pull_request', payload });
		await run();
		expect(outputs()['state']).toBe('failure');
		expect(outputs()['written']).toBe('0');
		expect(world.github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
		// A personal token writes as its user; the fake mirrors that.
		world.github.creator = 'octocat';
		runner({ event: 'pull_request', payload, inputs: { token: 'personal-token' } });
		await run();
		expect(outputs()['written']).toBe('1');
	});

	it('writes on a same-repository pull_request unless Dependabot triggered it', async () => {
		const payload = pullPayload(sha(12));
		(payload['repository'] as { full_name: string }).full_name = 'Acme/Widgets';
		runner({ event: 'pull_request', payload });
		await run();
		expect(outputs()['written']).toBe('1');
		runner({ event: 'pull_request', payload: pullPayload(sha(11)), actor: 'dependabot[bot]' });
		await run();
		expect(outputs()['state']).toBe('success');
		expect(outputs()['written']).toBe('0');
		expect(world.github.requests(/\/statuses\//, 'POST')).toHaveLength(1);
	});

	it('skips PR events against another branch and a pull_request without a payload', async () => {
		for (const event of ['pull_request_target', 'pull_request']) {
			runner({
				event,
				payload: pullPayload(sha(12), {
					pull_request: {
						...(pullPayload(sha(12))['pull_request'] as object),
						base: { ref: 'release' },
					},
				}),
			});
			await run();
			expect(JSON.parse(outputs()['summary'] as string)).toMatchObject({
				outOfScope: true,
				written: false,
			});
		}
		expect(world.github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
		runner({ event: 'pull_request', payload: {} });
		await run();
		expect(outputs()['state']).toBe('skipped');
	});

	it('evaluates a merge group against the base and skips one for another branch', async () => {
		runner({
			event: 'merge_group',
			payload: { merge_group: { head_sha: sha(11), base_ref: 'refs/heads/main' } },
		});
		await run();
		expect(outputs()['state']).toBe('success');
		expect(outputs()['written']).toBe('1');
		runner({
			event: 'merge_group',
			payload: { merge_group: { head_sha: sha(11), base_ref: 'refs/heads/release' } },
		});
		await run();
		expect(JSON.parse(outputs()['summary'] as string)).toMatchObject({
			outOfScope: true,
			written: false,
		});
		expect(world.github.requests(/\/statuses\//, 'POST')).toHaveLength(1);
	});

	it('moves on markers and refreshes on a push to the base, and ignores other branches', async () => {
		world.github.files.set(`${sha(3)}...${sha(5)}`, ['.nvmrc']);
		world.github.pull({ number: 1, headSha: sha(12) });
		runner({
			event: 'push',
			payload: { ref: 'refs/heads/main', repository: { default_branch: 'main' } },
			inputs: { markers: '.nvmrc\n' },
		});
		await run();
		expect(world.github.tags.get('pr-baseline')?.peeled).toBe(sha(5));
		expect(outputs()['written']).toBe('1');
		runner({ event: 'push', payload: { ref: 'refs/heads/feature' }, inputs: { base: 'main' } });
		await run();
		expect(outputs()['state']).toBe('skipped');
	});

	it('takes the base from the payload default branch on a push, and ignores tag pushes', async () => {
		const repository = { default_branch: 'main' };
		runner({ event: 'push', payload: { ref: 'refs/heads/feature', repository } });
		await run();
		expect(outputs()['state']).toBe('skipped');
		runner({ event: 'push', payload: { ref: 'refs/tags/main', repository } });
		await run();
		expect(outputs()['state']).toBe('skipped');
		runner({ event: 'push', payload: { ref: 'refs/heads/main', repository } });
		await run();
		expect(outputs()['state']).toBe('success');
		expect(outputs()['incomplete']).toBe('false');
		runner({ event: 'push', payload: { ref: 'refs/heads/main' } });
		await run();
		expect(outputs()['state']).toBe('error');
		process.exitCode = 0;
	});

	it('runs a non-forced move and refresh on a workflow_dispatch, ignoring its payload inputs', async () => {
		world.github.pull({ number: 1, headSha: sha(12) });
		runner({
			event: 'workflow_dispatch',
			payload: { inputs: { mode: 'report', baseline: 'ignored' } },
		});
		await run();
		expect(world.github.tags.get('pr-baseline')?.peeled).toBe(sha(3));
		expect(outputs()['written']).toBe('1');
	});

	it('fails the step on an incomplete refresh', async () => {
		world.github.commit(sha(13), [sha(1)]);
		world.github.pull({ number: 1, headSha: sha(12) });
		world.github.pull({ number: 2, headSha: sha(13) });
		runner({ event: 'schedule', payload: {}, inputs: { 'max-writes-per-run': '1' } });
		await run();
		expect(outputs()['incomplete']).toBe('true');
		expect(outputs()['written']).toBe('1');
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
	});

	it('evaluates the two-baseline configuration of the consumer template', async () => {
		world.github.commit(sha(14), [sha(1)]);
		world.github.tag('pr-baseline-docs', sha(4));
		world.github.files.set(`${sha(5)}...${sha(12)}`, ['docs/guide.md']);
		world.github.files.set(`${sha(5)}...${sha(14)}`, ['src/index.ts']);
		// The template's own list plus a scoped baseline, the way a monorepo consumer would extend it.
		const template = readFileSync(
			join(import.meta.dirname, '..', '..', 'action', 'workflow-template.yml'),
			'utf8',
		);
		const configured = JSON.parse(
			/^  PR_BASELINES: '(.*)'$/m.exec(template)?.[1] ?? '[]',
		) as unknown[];
		const baselines = JSON.stringify([
			...configured,
			{ tag: 'pr-baseline-docs', scope: ['docs/**'] },
		]);
		runner({ event: 'pull_request_target', payload: pullPayload(sha(12)), inputs: { baselines } });
		await run();
		expect(JSON.parse(outputs()['missing'] as string)).toEqual(['pr-baseline', 'pr-baseline-docs']);
		expect(summary()).toContain('Missing baselines: pr-baseline, pr-baseline-docs');
		runner({ event: 'pull_request_target', payload: pullPayload(sha(14)), inputs: { baselines } });
		await run();
		expect(JSON.parse(outputs()['missing'] as string)).toEqual(['pr-baseline']);
	});

	it('recovers on schedule and honors explicit dispatch modes', async () => {
		world.github.pull({ number: 1, headSha: sha(12) });
		runner({ event: 'schedule', payload: {} });
		await run();
		expect(outputs()['written']).toBe('1');
		expect(world.github.tags.get('pr-baseline')?.peeled).toBe(sha(3));
		runner({ event: 'workflow_dispatch', payload: {}, inputs: { mode: 'refresh-pr-statuses' } });
		await run();
		expect(outputs()['skipped']).toBe('1');
		runner({
			event: 'workflow_dispatch',
			payload: {},
			inputs: { mode: 'move-baseline', force: 'true' },
		});
		await run();
		expect(world.github.tags.get('pr-baseline')?.peeled).toBe(sha(5));
		// The failure written earlier reads the same after the move, so nothing is rewritten.
		expect(outputs()['skipped']).toBe('1');
	});
});

describe('action explicit modes and errors', () => {
	it('reports, with a failing step when a baseline is off the base', async () => {
		runner({ event: 'workflow_dispatch', payload: {}, inputs: { mode: 'report' } });
		await run();
		expect(allOutputs()['state']).toBe('success');
		expect(summary()).toContain('PR baseline report');
		world.github.commit(sha(20), [sha(2)]);
		world.github.tag('pr-baseline', sha(20));
		runner({ event: 'workflow_dispatch', payload: {}, inputs: { mode: 'report' } });
		await run();
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
	});

	it('requires a creator for a token that is not the workflow token and cannot answer GET /user', async () => {
		world.github.user = null;
		world.github.status(sha(12), {
			state: 'failure',
			description: 'old',
			creator: 'github-actions[bot]',
		});
		runner({
			event: 'pull_request_target',
			payload: pullPayload(sha(12)),
			inputs: { token: 'app-installation-token' },
		});
		await run();
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
		expect(world.github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
	});

	it('runs an explicit refresh-pr-status with a dry run and never writes', async () => {
		runner({
			event: 'workflow_dispatch',
			payload: {},
			inputs: { mode: 'refresh-pr-status', sha: sha(12), 'dry-run': 'true' },
		});
		await run();
		expect(allOutputs()['state']).toBe('failure');
		expect(world.github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
	});

	it('sets every output and a summary on a skip and on an error', async () => {
		runner({ event: 'pull_request_target', payload: pullPayload(sha(12), { action: 'closed' }) });
		await run();
		const skipped = outputs();
		expect(Object.keys(skipped).toSorted()).toEqual([
			'base',
			'baselines',
			'closed',
			'deferred',
			'description',
			'failed',
			'incomplete',
			'missing',
			'results-file',
			'skipped',
			'state',
			'summary',
			'written',
		]);
		expect(skipped['state']).toBe('skipped');
		expect(summary()).toContain('PR baseline: skipped');
		runner({ event: 'workflow_dispatch', payload: {}, inputs: { mode: 'dance', base: 'main' } });
		await run();
		const failed = outputs();
		expect(failed['state']).toBe('error');
		expect(failed['base']).toBe('main');
		expect(failed['description']).toContain('Unknown mode');
		expect(summary()).toContain('PR baseline: error');
		process.exitCode = 0;
	});

	it('rejects a baselines file reference', async () => {
		runner({ event: 'schedule', payload: {}, inputs: { baselines: '@baselines.json' } });
		await run();
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
		expect(outputs()['description']).toContain('does not read files');
	});

	it('bounds the summary output by dropping entries', () => {
		const entries = Array.from({ length: 200 }, (_, index) => ({
			number: index + 1,
			sha: sha(index + 100),
			outcome: 'failed' as const,
			error: 'x'.repeat(2_000),
		}));
		const result = {
			base: 'main',
			baselines: [],
			openPulls: 200,
			written: 0,
			skipped: 0,
			closed: 0,
			deferred: 0,
			outOfScope: 0,
			failed: 200,
			incomplete: true,
			reason: 'failed',
			entries,
			ancestry: 'api',
			dryRun: false,
		} as RefreshPrStatusesResult;
		const text = boundedSummary(result, {}, 60_000);
		expect(text.length).toBeLessThanOrEqual(60_000);
		const parsed = JSON.parse(text) as { entries: unknown[]; entriesOmitted: number };
		expect(parsed.entries.length + parsed.entriesOmitted).toBe(200);
		expect(parsed.entries.length).toBeGreaterThan(0);
		expect(
			JSON.parse(boundedSummary(result, {}, 1_000_000)) as { entriesOmitted: number },
		).toMatchObject({
			entriesOmitted: 0,
		});
		const tiny = JSON.parse(boundedSummary(result, {}, 100)) as {
			truncated: boolean;
			entriesOmitted: number;
		};
		expect(tiny).toMatchObject({ truncated: true, entriesOmitted: 200 });
		expect(boundedSummary(result, {}, 100).length).toBeLessThan(400);
		const moves = Array.from({ length: 50 }, (_, index) => ({
			tag: `baseline-${index}`,
			from: null,
			to: sha(index),
			moved: index === 0,
			note: 'y'.repeat(5_000),
		}));
		const withMoves = JSON.parse(boundedSummary({ ...result, entries: [] }, { moves }, 5_000)) as {
			truncated: boolean;
			moves: { tag: string; moved: boolean; note?: string }[];
		};
		expect(withMoves.truncated).toBe(true);
		expect(withMoves.moves).toHaveLength(50);
		expect(withMoves.moves[0]).toEqual({ tag: 'baseline-0', moved: true });
	});

	it('rejects an unknown mode and a refresh-pr-status without a sha', async () => {
		runner({ event: 'workflow_dispatch', payload: {}, inputs: { mode: 'dance' } });
		await run();
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
		runner({ event: 'workflow_dispatch', payload: {}, inputs: { mode: 'refresh-pr-status' } });
		await run();
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
	});
});
