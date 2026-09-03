import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeGitHub, sha } from './helpers/fake-github.ts';
import { serve } from './helpers/server.ts';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'src', 'cli.ts');
let close: (() => Promise<void>) | undefined;

afterEach(async () => {
	await close?.();
	close = undefined;
});

/** Boots the fake behind HTTP and runs the CLI against it. */
async function run(setup: (github: FakeGitHub) => void, args: string[]) {
	const github = new FakeGitHub();
	github.chain(1, 5);
	github.branch('main', sha(5));
	setup(github);
	const server = await serve(github);
	close = server.close;
	// Spawned asynchronously: a synchronous spawn would block the loop that serves the fake.
	const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
		(resolve) => {
			const child = spawn(
				'node',
				[
					cli,
					...args,
					'--repo',
					github.repo,
					'--token',
					'x',
					'--api-url',
					server.url,
					'--graphql-url',
					`${server.url}/graphql`,
					'--creator',
					'github-actions[bot]',
					'--json',
				],
				{ env: { ...process.env, GITHUB_REPOSITORY: undefined, GITHUB_TOKEN: undefined } },
			);
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
			child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
			child.on('close', (status) => resolve({ status, stdout, stderr }));
		},
	);
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		github,
		json: () => JSON.parse(result.stdout) as Record<string, unknown>,
	};
}

/** Two stale PRs against a baseline at commit 4. */
function twoStalePulls(gh: FakeGitHub): void {
	gh.tag('pr-baseline', sha(4));
	gh.commit(sha(10), [sha(3)]);
	gh.commit(sha(11), [sha(3)]);
	gh.pull({ number: 1, headSha: sha(10) });
	gh.pull({ number: 2, headSha: sha(11) });
}

describe('cli end to end', () => {
	it('exits 0 on a passing status and prints the result as JSON', async () => {
		const { status, json } = await run(
			(gh) => {
				gh.tag('pr-baseline', sha(3));
				gh.commit(sha(10), [sha(4)]);
				gh.pull({ number: 1, headSha: sha(10) });
			},
			['refresh-pr-status', '--pr', '1'],
		);
		expect(status).toBe(0);
		expect(json()).toMatchObject({ sha: sha(10), written: true, verdict: { kind: 'pass' } });
	});

	it('exits 1 on a failing status', async () => {
		const { status, github } = await run(
			(gh) => {
				gh.tag('pr-baseline', sha(4));
				gh.commit(sha(10), [sha(3)]);
				gh.pull({ number: 1, headSha: sha(10) });
			},
			['refresh-pr-status', '--pr', '1'],
		);
		expect(status).toBe(1);
		expect(github.latestStatus(sha(10), 'PR baseline')?.state).toBe('failure');
	});

	it('exits 1 on an incomplete refresh and 0 once it converges', async () => {
		const capped = await run(twoStalePulls, ['refresh-pr-statuses', '--max-writes-per-run', '1']);
		expect(capped.status).toBe(1);
		expect(capped.json()).toMatchObject({ written: 1, incomplete: true, reason: 'write-cap' });
		const full = await run(twoStalePulls, ['refresh-pr-statuses']);
		expect(full.status).toBe(0);
		expect(full.json()).toMatchObject({ written: 2, incomplete: false });
	});

	it('exits 2 when report finds a baseline off the base branch', async () => {
		const { status, json } = await run(
			(gh) => {
				gh.commit(sha(20), [sha(2)]);
				gh.tag('pr-baseline', sha(20));
			},
			['report'],
		);
		expect(status).toBe(2);
		expect(json()).toMatchObject({ offBase: ['pr-baseline'] });
	});

	it('runs a dry-run move and refresh without writing', async () => {
		const { status, json, github } = await run(
			(gh) => {
				gh.commit(sha(10), [sha(3)]);
				gh.pull({ number: 1, headSha: sha(10) });
			},
			['move-baseline', '--force', '--refresh-pr-statuses', '--dry-run'],
		);
		expect(status).toBe(0);
		expect(json()).toMatchObject({ moves: [{ moved: true, to: sha(5) }], refresh: { written: 1 } });
		expect(github.tags.has('pr-baseline')).toBe(false);
		expect(github.requests(/\/statuses\//, 'POST')).toHaveLength(0);
	});
});
