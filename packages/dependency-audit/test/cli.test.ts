import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
/*
 * Spawn the TS source where Node strips types natively; on a Node line without type stripping (20.x in the CI compat matrix) fall back to the built CLI, which that job builds beforehand.
 */
const cli = process.features.typescript
	? join(here, '..', 'src', 'cli.ts')
	: join(here, '..', 'dist', 'cli.js');
const targets = join(here, 'fixtures', 'targets');
// A self-contained target (no declared deps → no registry access) keeps the CLI hermetic.
const okTarget = join(targets, 'require-forms');
const badTarget = join(targets, '__no_such_target__');

/*
 * Some behaviors are tested at the unit level rather than here: the CLI always uses the real
 * pacote provider, so any multi-target fixture that produces a `causedBy`/`--collapse-root-cause`
 * scenario (a producer with a coverage notice + a consumer of it) would fire the registry `@types`
 * probe from the Phase C refinement — a real network call, flaky in CI. So `correlateRootCauses`,
 * `isCollapsed`, and `resultFails` are covered in `correlate.test.ts` (pure, hermetic) instead.
 */

/**
 * Runs the CLI as a subprocess, capturing status + stdout + stderr.
 * `spawnSync` always captures both streams (even on a clean exit), so a test can assert that a successful run emits nothing on stderr — the child's stderr is a pipe, not a TTY, so the progress spinner stays silent.
 * `FORCE_COLOR` / `NO_COLOR` / `GITHUB_ACTIONS` are cleared for the child by default so every output assertion is hermetic regardless of the runner's environment (the suite itself often runs in GitHub Actions, where color is forced on); a test that wants color re-sets them via `env` (a key set to `undefined` stays unset — Node omits undefined env).
 */
function runCli(
	args: string[],
	env?: NodeJS.ProcessEnv,
): { status: number; stdout: string; stderr: string } {
	const result = spawnSync('node', [cli, ...args], {
		encoding: 'utf8',
		env: {
			...process.env,
			FORCE_COLOR: undefined,
			NO_COLOR: undefined,
			GITHUB_ACTIONS: undefined,
			...env,
		},
	});
	return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
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
		const parsed = JSON.parse(stdout) as { results: Array<Record<string, unknown>> };
		expect(parsed.results).toHaveLength(2);
		expect(parsed.results.some((entry) => 'error' in entry)).toBe(true);
		expect(parsed.results.some((entry) => 'findings' in entry)).toBe(true);
	});

	it('wraps --json output in a { tool, version, results } envelope', () => {
		const { stdout } = runCli(['--json', okTarget]);
		const parsed = JSON.parse(stdout) as { tool: string; version: string; results: unknown[] };
		expect(parsed.tool).toBe('dependency-audit');
		// The envelope records the producing version so a saved artifact is reproducible.
		expect(parsed.version).toMatch(/^\d+\.\d+\.\d+/);
		expect(Array.isArray(parsed.results)).toBe(true);
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

	it('writes no progress to stderr when stderr is not a TTY', () => {
		// The child's stderr is a pipe here, so the spinner must stay silent — progress never pollutes a redirect or a captured log.
		const { status, stdout, stderr } = runCli([okTarget]);
		expect(status).toBe(1);
		expect(stdout).toContain('require-forms');
		expect(stderr).toBe('');
	});

	it('rejects a non-integer --concurrency before auditing (exit 2)', () => {
		const { status, stderr } = runCli(['--concurrency', 'abc', okTarget]);
		expect(status).toBe(2);
		expect(stderr).toMatch(/Invalid --concurrency.*expected an integer >= 1/);
	});

	it('rejects --concurrency 0 (must be >= 1)', () => {
		const { status, stderr } = runCli(['--concurrency', '0', okTarget]);
		expect(status).toBe(2);
		expect(stderr).toMatch(/Invalid --concurrency/);
	});

	it('rejects a malformed DEPENDENCY_AUDIT_RETRIES env value', () => {
		const { status, stderr } = runCli([okTarget], { DEPENDENCY_AUDIT_RETRIES: '-1' });
		expect(status).toBe(2);
		expect(stderr).toMatch(/Invalid DEPENDENCY_AUDIT_RETRIES.*expected an integer >= 0/);
	});

	it('accepts a valid --concurrency and still audits (exit 1 on the finding)', () => {
		// A self-contained target (no registry access) exercises the happy path of the knob.
		const { status, stdout } = runCli(['--concurrency', '1', okTarget]);
		expect(status).toBe(1);
		expect(stdout).toContain('require-forms');
	});
});

describe('cli unused ignore rules', () => {
	it('warns on stdout, after the summary, when an --ignore value matches nothing', () => {
		const { status, stdout } = runCli(['--ignore', 'nope', okTarget]);
		// The res-dep finding still fails the run; the stale flag is a warning, not a failure.
		expect(status).toBe(1);
		const warning = stdout.indexOf(
			'warning: unused ignore rule — --ignore nope matched nothing in this run',
		);
		const summary = stdout.search(/\d+ package(s)?, /);
		expect(warning).toBeGreaterThan(0);
		// The warning lands last — below the summary — so it reads as the run's final word.
		expect(warning).toBeGreaterThan(summary);
	});

	it('stays silent when the ignore is used', () => {
		// Other findings remain (exit 1) — the point is no staleness warning for a rule that matched.
		const { status, stdout } = runCli(['--ignore', 'res-dep', okTarget]);
		expect(status).toBe(1);
		expect(stdout).not.toContain('unused ignore rule');
	});

	it('names a stale config rule by its file and JSON shape', () => {
		const dir = mkdtempSync(join(tmpdir(), 'da-unused-'));
		const cfg = join(dir, 'audit.json');
		writeFileSync(cfg, JSON.stringify({ ignore: [{ package: 'nope' }] }));
		const { stdout } = runCli(['--config', cfg, okTarget]);
		expect(stdout).toContain(`${cfg}: {"package":"nope"}`);
	});

	it('--fail-unused-ignores turns a stale rule into exit 1 on an otherwise clean run', () => {
		// Suppress every finding the fixture produces, so only the stale rule decides the exit code.
		const suppressAll = ['attr-dep', 'cr-esm-dep', 'crr-dep', 'cr-dep', 'res-dep'].flatMap(
			(value) => ['--ignore', value],
		);
		const lax = runCli([...suppressAll, '--ignore', 'nope', okTarget]);
		expect(lax.status).toBe(0);
		// Non-fatal by default → a `warning:`.
		expect(lax.stdout).toContain('warning: unused ignore rule');
		const strict = runCli([...suppressAll, '--ignore', 'nope', '--fail-unused-ignores', okTarget]);
		expect(strict.status).toBe(1);
		// Fatal under the flag → labelled `error:` to match the exit code.
		expect(strict.stdout).toContain('error: unused ignore rule');
	});

	it('keeps --json stdout machine-readable while warning on stderr', () => {
		const { stdout, stderr } = runCli(['--json', '--ignore', 'nope', okTarget]);
		// Under --json the warning stays on stderr so the stdout payload parses cleanly.
		expect(stderr).toContain('unused ignore rule');
		expect(stdout).not.toContain('unused ignore rule');
		expect(() => JSON.parse(stdout)).not.toThrow();
	});

	it('suppresses staleness warnings when any target errored (the match may live there)', () => {
		const { status, stdout, stderr } = runCli(['--ignore', 'nope', okTarget, badTarget]);
		expect(status).toBe(2);
		expect(stdout).not.toContain('unused ignore rule');
		expect(stderr).not.toContain('unused ignore rule');
	});

	it('still warns when a target is merely skipped (a non-package target cannot have contained the match)', () => {
		const notPkg = join(here, 'fixtures', 'not-a-package.md');
		const { status, stdout } = runCli(['--ignore', 'nope', okTarget, notPkg]);
		expect(status).toBe(1);
		expect(stdout).toContain('unused ignore rule — --ignore nope');
	});
});

describe('cli output integrity', () => {
	it('does not truncate a large --json payload when piped (exit via flush, not process.exit)', () => {
		// >128 KB exceeds the OS pipe buffer; an abrupt process.exit() would drop the tail.
		const many = Array.from({ length: 120 }, () => okTarget);
		const { stdout } = runCli(['--json', ...many]);
		expect(stdout.length).toBeGreaterThan(131072);
		// JSON.parse throws on a truncated payload; a full `results` array has one entry per target.
		const parsed = JSON.parse(stdout) as { results: unknown[] };
		expect(parsed.results).toHaveLength(120);
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

	it('emits ANSI color under GitHub Actions even when piped (its log viewer renders ANSI)', () => {
		expect(runCli([okTarget], { GITHUB_ACTIONS: 'true' }).stdout.includes(ESC)).toBe(true);
	});

	it('still honors NO_COLOR under GitHub Actions', () => {
		const { stdout } = runCli([okTarget], { GITHUB_ACTIONS: 'true', NO_COLOR: '1' });
		expect(stdout.includes(ESC)).toBe(false);
	});
});

describe('cli findings recap', () => {
	it('lists the failing findings, naming the package, just above the summary', () => {
		const { stdout } = runCli([okTarget]);
		const recap = stdout.indexOf('Findings:');
		const summary = stdout.search(/\d+ package(s)?, /);
		// The recap appears, and sits below the per-target blocks but above the summary line.
		expect(recap).toBeGreaterThan(0);
		expect(summary).toBeGreaterThan(recap);
		// Each recap row names the owning package so it reads standalone.
		expect(stdout.slice(recap)).toMatch(
			/✗ @fixture\/require-forms\s+runtime\s+\[undeclared]\s+res-dep/,
		);
	});

	it('omits the recap on a clean run (nothing fails)', () => {
		const clean = join(targets, 'types-unreachable');
		const { status, stdout } = runCli([clean]);
		expect(status).toBe(0);
		expect(stdout).not.toContain('Findings:');
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
		const parsed = JSON.parse(stdout) as { results: Array<Record<string, unknown>> };
		expect(parsed.results[0]).toHaveProperty('skipped');
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
