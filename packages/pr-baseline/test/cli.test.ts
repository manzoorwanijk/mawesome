import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'src', 'cli.ts');

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
	const result = spawnSync('node', [cli, ...args], {
		encoding: 'utf8',
		cwd: here,
		env: {
			...process.env,
			GITHUB_REPOSITORY: undefined,
			GITHUB_TOKEN: undefined,
			GITHUB_API_URL: undefined,
			...env,
		},
	});
	return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('cli', () => {
	it('prints usage and exits 2 without a command', () => {
		const { status, stderr } = run([]);
		expect(status).toBe(2);
		expect(stderr).toContain('Usage:');
	});

	it('prints help and the version', () => {
		expect(run(['--help'])).toMatchObject({ status: 0 });
		expect(run(['--help']).stdout).toContain('move-baseline');
		expect(run(['-v']).stdout).toMatch(/^\d+\.\d+\.\d+/);
	});

	it('rejects an unknown command and an unknown flag before touching credentials', () => {
		expect(run(['fanout'])).toMatchObject({ status: 2 });
		const unknown = run(['refresh-pr-statuses', '--bogus']);
		expect(unknown.status).toBe(2);
		expect(unknown.stderr).toContain('--bogus');
	});

	it('reports a missing repository as a configuration error', () => {
		const { status, stderr } = run(['refresh-pr-statuses']);
		expect(status).toBe(2);
		expect(stderr).toContain('GITHUB_REPOSITORY');
	});

	it('names the flag when a write cap is not a positive integer', () => {
		for (const [flag, value] of [
			['--max-writes-per-run', '0'],
			['--max-writes-per-minute', 'x'],
			['--max-writes-per-run', '9'.repeat(23)],
		] as const) {
			const { status, stderr } = run([
				'refresh-pr-statuses',
				'--repo',
				'a/b',
				'--token',
				'x',
				flag,
				value,
			]);
			expect(status).toBe(2);
			expect(stderr).toContain(`${flag} expects a positive integer, got "${value}".`);
		}
	});

	it('validates baselines before any request', () => {
		const { status, stderr } = run([
			'refresh-pr-statuses',
			'--repo',
			'a/b',
			'--token',
			'x',
			'--baselines',
			'[]',
		]);
		expect(status).toBe(2);
		expect(stderr).toContain('at least one entry');
		const mixed = run([
			'refresh-pr-statuses',
			'--repo',
			'a/b',
			'--token',
			'x',
			'--baselines',
			'[{"tag":"a"}]',
			'--tag',
			'b',
		]);
		expect(mixed.status).toBe(2);
		expect(mixed.stderr).toContain('cannot be combined');
	});

	it('rejects non-integer numeric flags', () => {
		const { status, stderr } = run([
			'refresh-pr-status',
			'--repo',
			'a/b',
			'--token',
			'x',
			'--pr',
			'seven',
		]);
		expect(status).toBe(2);
		expect(stderr).toContain('--pr');
	});

	it('needs a token for API ancestry', () => {
		const { status, stderr } = run(['report', '--repo', 'a/b']);
		expect(status).toBe(2);
		expect(stderr).toContain('GITHUB_TOKEN');
	});

	it('rejects extra positionals', () => {
		const { status, stderr } = run(['report', 'extra', '--repo', 'a/b', '--token', 'x']);
		expect(status).toBe(2);
		expect(stderr).toContain('Unexpected argument');
	});
});

describe('cli command options', () => {
	it('rejects options that belong to another command', () => {
		const refresh = run(['refresh-pr-statuses', '--force', '--repo', 'a/b', '--token', 'x']);
		expect(refresh.status).toBe(2);
		expect(refresh.stderr).toContain('--force cannot be used with "refresh-pr-statuses"');
		const status = run([
			'refresh-pr-status',
			'abc',
			'--refresh-pr-statuses',
			'--to',
			'x',
			'--repo',
			'a/b',
			'--token',
			'x',
		]);
		expect(status.status).toBe(2);
		expect(status.stderr).toContain('--to');
		expect(status.stderr).toContain('--refresh-pr-statuses');
	});
});

describe('cli refresh-pr-status target', () => {
	it('rejects a commit together with --pr before any request', () => {
		const { status, stderr } = run([
			'refresh-pr-status',
			'abc',
			'--pr',
			'1',
			'--repo',
			'a/b',
			'--token',
			'x',
		]);
		expect(status).toBe(2);
		expect(stderr).toContain('either a commit or --pr');
	});
});
