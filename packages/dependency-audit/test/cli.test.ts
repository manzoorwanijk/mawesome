import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'src', 'cli.ts');
const targets = join(here, 'fixtures', 'targets');
// A self-contained target (no declared deps → no registry access) keeps the CLI hermetic.
const okTarget = join(targets, 'require-forms');
const badTarget = join(targets, '__no_such_target__');

/** Runs the CLI as a subprocess (Node strips the TS types), capturing status + stdout. */
function runCli(args: string[]): { status: number; stdout: string } {
	try {
		const stdout = execFileSync('node', [cli, ...args], { encoding: 'utf8' });
		return { status: 0, stdout };
	} catch (error) {
		const e = error as { status: number | null; stdout: string };
		return { status: e.status ?? -1, stdout: e.stdout };
	}
}

describe('cli batch isolation', () => {
	it('reports a failed target without discarding the others (exit 2)', () => {
		const { status, stdout } = runCli([okTarget, badTarget]);
		// The good target is still audited and printed...
		expect(stdout).toContain('require-forms');
		// ...and the bad one is surfaced as a per-target error, not a fatal crash.
		expect(stdout).toMatch(/error/i);
		expect(status).toBe(2);
	});

	it('emits a per-target error entry under --json', () => {
		const { stdout } = runCli(['--json', okTarget, badTarget]);
		const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(parsed).toHaveLength(2);
		expect(parsed.some((entry) => 'error' in entry)).toBe(true);
		expect(parsed.some((entry) => 'findings' in entry)).toBe(true);
	});

	it('prints the version with --version', () => {
		const { status, stdout } = runCli(['--version']);
		expect(status).toBe(0);
		expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
	});
});
