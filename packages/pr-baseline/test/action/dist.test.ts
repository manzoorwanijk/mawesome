import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeGitHub, sha } from '../helpers/fake-github.ts';
import { serve } from '../helpers/server.ts';

const root = join(import.meta.dirname, '..', '..');
const bundle = join(root, 'action', 'dist', 'index.js');
const dir = mkdtempSync(join(tmpdir(), 'pr-baseline-dist-'));
let github: FakeGitHub;
let server: Awaited<ReturnType<typeof serve>> | undefined;

/** Runs the built bundle the way the runner does: a separate process, inputs and event in the environment. */
async function runBundle(input: {
	event: string;
	payload: Record<string, unknown>;
	inputs?: Record<string, string>;
}): Promise<{ code: number; outputs: Record<string, string>; stdout: string }> {
	const eventPath = join(dir, 'event.json');
	const outputPath = join(dir, 'output.txt');
	writeFileSync(eventPath, JSON.stringify(input.payload));
	writeFileSync(outputPath, '');
	writeFileSync(join(dir, 'summary.md'), '');
	const url = (server as { url: string }).url;
	const env: Record<string, string> = {
		PATH: process.env['PATH'] ?? '',
		GITHUB_EVENT_NAME: input.event,
		GITHUB_EVENT_PATH: eventPath,
		GITHUB_REPOSITORY: github.repo,
		GITHUB_API_URL: url,
		GITHUB_GRAPHQL_URL: `${url}/graphql`,
		GITHUB_SERVER_URL: url,
		GITHUB_OUTPUT: outputPath,
		GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
		GITHUB_ACTOR: 'octocat',
		RUNNER_TEMP: dir,
		INPUT_TOKEN: 'workflow-token',
		'INPUT_GITHUB-TOKEN-PROBE': 'workflow-token',
	};
	for (const [name, value] of Object.entries(input.inputs ?? {})) {
		env[`INPUT_${name.toUpperCase()}`] = value;
	}
	const { code, stdout } = await new Promise<{ code: number; stdout: string }>((resolve) => {
		const child = spawn(process.execPath, [bundle], { env, stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		child.stdout.on('data', (chunk: Buffer) => {
			out += chunk.toString();
		});
		child.stderr.on('data', (chunk: Buffer) => {
			out += chunk.toString();
		});
		child.on('close', (status) => resolve({ code: status ?? -1, stdout: out }));
	});
	const outputs: Record<string, string> = {};
	const pattern = /^([^\n<]+)<<(\S+)\n([\s\S]*?)\n\2$/gm;
	for (const match of readFileSync(outputPath, 'utf8').matchAll(pattern)) {
		outputs[match[1] as string] = match[3] as string;
	}
	return { code, outputs, stdout };
}

beforeAll(() => {
	// The bundle under test is the one the mirror ships; build it here so a stale dist cannot pass.
	execFileSync('pnpm', ['exec', 'tsdown', '-c', 'tsdown.action.config.ts'], {
		cwd: root,
		stdio: 'ignore',
	});
	expect(existsSync(bundle)).toBe(true);
}, 120_000);

beforeEach(async () => {
	await server?.close();
	github = new FakeGitHub();
	github.chain(1, 5);
	github.branch('main', sha(5));
	github.tag('pr-baseline', sha(3));
	github.commit(sha(11), [sha(4)]);
	github.commit(sha(12), [sha(2)]);
	server = await serve(github);
});

afterAll(async () => {
	await server?.close();
	rmSync(dir, { recursive: true, force: true });
});

const pull = (head: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	action: 'synchronize',
	repository: { full_name: 'acme/widgets', default_branch: 'main' },
	pull_request: {
		number: 1,
		head: { sha: head, repo: { full_name: 'acme/widgets' } },
		base: { ref: 'main' },
		merged: false,
	},
	...extra,
});

describe('built action bundle', () => {
	it('refreshes the status and writes on pull_request_target', async () => {
		const result = await runBundle({ event: 'pull_request_target', payload: pull(sha(12)) });
		expect(result.code).toBe(0);
		expect(result.outputs['state']).toBe('failure');
		expect(result.outputs['written']).toBe('1');
		expect(github.latestStatus(sha(12), 'PR baseline')?.creator).toBe('github-actions[bot]');
	});

	it('moves and refreshes on a merged pull_request_target, a base push and a schedule', async () => {
		github.pull({ number: 1, headSha: sha(11) });
		github.pull({
			number: 2,
			headSha: sha(4),
			state: 'closed',
			merged: true,
			labels: ['Require PR update'],
			mergeCommit: sha(4),
		});
		const merged = pull(sha(4), {
			action: 'closed',
			pull_request: { ...(pull(sha(4))['pull_request'] as object), merged: true },
		});
		let result = await runBundle({ event: 'pull_request_target', payload: merged });
		expect(result.code).toBe(0);
		expect(github.tags.get('pr-baseline')?.peeled).toBe(sha(5));
		expect(result.outputs['written']).toBe('1');
		result = await runBundle({
			event: 'push',
			payload: { ref: 'refs/heads/main', repository: { default_branch: 'main' } },
		});
		expect(result.code).toBe(0);
		expect(result.outputs['skipped']).toBe('1');
		result = await runBundle({ event: 'schedule', payload: {} });
		expect(result.code).toBe(0);
		expect(result.outputs['incomplete']).toBe('false');
	});

	it('recovers on a bare workflow_dispatch and honors the explicit modes', async () => {
		github.pull({ number: 1, headSha: sha(12) });
		let result = await runBundle({
			event: 'workflow_dispatch',
			payload: {},
		});
		expect(result.code).toBe(0);
		expect(result.outputs['written']).toBe('1');
		result = await runBundle({
			event: 'workflow_dispatch',
			payload: {},
			inputs: { mode: 'report' },
		});
		expect(result.code).toBe(0);
		expect(result.outputs['state']).toBe('success');
		result = await runBundle({
			event: 'merge_group',
			payload: { merge_group: { head_sha: sha(11), base_ref: 'refs/heads/main' } },
		});
		expect(result.outputs['state']).toBe('success');
	});

	it('fails the step on a configuration error with every output set', async () => {
		const result = await runBundle({
			event: 'workflow_dispatch',
			payload: {},
			inputs: { mode: 'dance' },
		});
		expect(result.code).toBe(1);
		expect(result.outputs['state']).toBe('error');
		expect(result.stdout).toContain('Unknown mode "dance"');
	});
});
