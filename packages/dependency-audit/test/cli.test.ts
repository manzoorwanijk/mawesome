import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'src', 'cli.ts');
const targets = join(here, 'fixtures', 'targets');
// A self-contained target (no declared deps → no registry access) keeps the CLI hermetic.
const okTarget = join(targets, 'require-forms');
const badTarget = join(targets, '__no_such_target__');

/**
 * Runs the CLI as a subprocess (Node strips the TS types), capturing status + stdout + stderr.
 * `FORCE_COLOR` / `NO_COLOR` are cleared for the child by default so every output assertion is
 * hermetic regardless of the runner's environment; a test that wants color re-sets them via
 * `env` (a key set to `undefined` stays unset — Node omits undefined env values).
 */
function runCli(
	args: string[],
	env?: NodeJS.ProcessEnv,
): { status: number; stdout: string; stderr: string } {
	try {
		const stdout = execFileSync('node', [cli, ...args], {
			encoding: 'utf8',
			env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: undefined, ...env },
		});
		return { status: 0, stdout, stderr: '' };
	} catch (error) {
		const e = error as { status: number | null; stdout: string; stderr: string };
		return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
	}
}

describe('cli batch isolation', () => {
	it('reports a failed target without discarding the others (exit 2)', () => {
		const { status, stdout } = runCli([okTarget, badTarget]);
		// The good target is still audited and printed, with the specifier in the headline...
		expect(stdout).toContain('require-forms');
		expect(stdout).toMatch(/✗ runtime\s+\[undeclared]\s+res-dep/);
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

	it('reports a malformed --config with the "Invalid config" context', () => {
		const dir = mkdtempSync(join(tmpdir(), 'da-cfg-'));
		const cfg = join(dir, 'bad.json');
		writeFileSync(cfg, '{ not: valid json');
		const { status, stderr } = runCli(['--config', cfg, okTarget]);
		expect(status).toBe(2);
		expect(stderr).toContain(`Invalid config ${cfg}`);
	});
});

describe('cli output integrity', () => {
	it('does not truncate a large --json payload when piped (exit via flush, not process.exit)', () => {
		// >128 KB exceeds the OS pipe buffer; an abrupt process.exit() would drop the tail.
		const many = Array.from({ length: 120 }, () => okTarget);
		const { stdout } = runCli(['--json', ...many]);
		expect(stdout.length).toBeGreaterThan(131072);
		// JSON.parse throws on a truncated payload; a full array has one entry per target.
		const parsed = JSON.parse(stdout) as unknown[];
		expect(parsed).toHaveLength(120);
	});
});

describe('cli color', () => {
	// The ESC byte (char 27) that introduces every ANSI style sequence.
	const ESC = String.fromCharCode(27);

	it('emits no ANSI when piped (not a TTY)', () => {
		// runCli clears FORCE_COLOR/NO_COLOR, so the result depends only on the (piped) TTY check.
		expect(runCli([okTarget]).stdout.includes(ESC)).toBe(false);
	});

	it('emits ANSI color when FORCE_COLOR is set', () => {
		expect(runCli([okTarget], { FORCE_COLOR: '1' }).stdout.includes(ESC)).toBe(true);
	});
});

describe('cli skip (non-package targets)', () => {
	const notPkg = join(here, 'fixtures', 'not-a-package.md');

	it('skips a non-package path without escalating a findings run to an error run', () => {
		// require-forms has findings (exit 1); a stray .md skip must keep it at 1, not 2.
		const { status, stdout } = runCli([okTarget, notPkg]);
		expect(stdout).toMatch(/↷ skipped/);
		expect(stdout).toMatch(/1 skipped/);
		expect(status).toBe(1);
	});

	it('exits 0 when the only targets are skips', () => {
		const { status, stdout } = runCli([notPkg]);
		expect(stdout).toMatch(/↷ skipped/);
		expect(status).toBe(0);
	});

	it('represents a skip as { target, skipped } under --json', () => {
		const { stdout } = runCli(['--json', notPkg]);
		const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(parsed[0]).toHaveProperty('skipped');
	});
});

describe('cli coverage notices', () => {
	const unreachable = join(targets, 'types-unreachable');

	it('shows a coverage notice but still exits 0 by default', () => {
		const { status, stdout } = runCli([unreachable]);
		expect(stdout).toMatch(/ℹ/);
		expect(stdout).toMatch(/1 notice/);
		expect(status).toBe(0);
	});

	it('fails (exit 1) on a coverage notice under --require-types', () => {
		const { status } = runCli(['--require-types', unreachable]);
		expect(status).toBe(1);
	});
});
