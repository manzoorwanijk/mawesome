#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { SkippedTargetError } from './acquire.ts';
import { audit } from './audit.ts';
import { mapLimit } from './concurrency.ts';
import { parseIgnoreRules } from './ignore.ts';
import type { AuditResult, Finding, IgnoreRule } from './types.ts';

/** Max targets audited in parallel; each target itself fans out to its own deps. */
const TARGET_CONCURRENCY = 6;

/**
 * Per-target result: an audit, a hard error (exit 2), or a skip (a non-package path, e.g. a
 * stray glob match — neutral, never escalates the exit code).
 */
type Outcome =
	| { target: string; result: AuditResult }
	| { target: string; error: string }
	| { target: string; skipped: string };

const VERSION = readSelfVersion();

const USAGE = `dependency-audit v${VERSION} — verify a package's released imports are all declared

Usage:
  dependency-audit [options] <target...>

A target is a package directory, a .tgz path, a published spec (name@version,
name@tag, @scope/name), or an http(s) tarball URL.

Options:
  --ignore <value>  Suppress findings whose package OR specifier equals <value>
                    (repeatable). Suppressed findings are still listed.
  --config <path>   Load ignore rules from a JSON config (default:
                    ./dependency-audit.config.json if present).
  --condition <name>  Activate an extra resolution condition (e.g. browser) for
                    entry discovery and resolution (repeatable).
  --require-types   Treat a missing/unreachable type surface (a coverage notice)
                    as a failure rather than just a notice.
  --json            Emit machine-readable JSON: one entry per target (an
                    AuditResult, or { target, error } for a failed audit).
  -v, --version     Print the version.
  -h, --help        Show this help.

Exit codes: 0 = clean, 1 = findings, 2 = error.`;

const DEFAULT_CONFIG = 'dependency-audit.config.json';

/** Reads this package's own version from its manifest (next to the built bin). */
function readSelfVersion(): string {
	try {
		const manifest = JSON.parse(
			readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
		) as { version?: string };
		return manifest.version ?? '0.0.0';
	} catch {
		return '0.0.0';
	}
}

async function main(): Promise<number> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			ignore: { type: 'string', multiple: true },
			config: { type: 'string' },
			condition: { type: 'string', multiple: true },
			'require-types': { type: 'boolean', default: false },
			json: { type: 'boolean', default: false },
			version: { type: 'boolean', short: 'v', default: false },
			help: { type: 'boolean', short: 'h', default: false },
		},
	});

	if (values.version) {
		console.log(VERSION);
		return 0;
	}
	if (values.help) {
		console.log(USAGE);
		return 0;
	}
	if (positionals.length === 0) {
		console.error(USAGE);
		return 2;
	}

	const ignore = [...loadConfigRules(values.config), ...cliIgnoreRules(values.ignore ?? [])];
	const conditions = values.condition ?? [];

	/* Each audit is self-contained (its own temp dirs), so targets run concurrently —
	 * but bounded, and each isolated, so one target's failure reports as an error for
	 * that target instead of discarding every other target's result. */
	const outcomes = await mapLimit(
		positionals,
		TARGET_CONCURRENCY,
		async (target): Promise<Outcome> => {
			try {
				return { target, result: await audit(target, { ignore, conditions }) };
			} catch (error) {
				if (error instanceof SkippedTargetError) {
					return { target, skipped: error.reason };
				}
				return { target, error: error instanceof Error ? error.message : String(error) };
			}
		},
	);

	if (values.json) {
		console.log(JSON.stringify(outcomes.map(jsonEntry), null, 2));
	} else {
		for (const outcome of outcomes) {
			if ('result' in outcome) {
				printResult(outcome.result);
			} else if ('skipped' in outcome) {
				printSkipped(outcome);
			} else {
				printError(outcome);
			}
		}
		printSummary(outcomes);
	}

	const anyError = outcomes.some((outcome) => 'error' in outcome);
	const anyFinding = outcomes.some((outcome) => 'result' in outcome && !outcome.result.ok);
	// `--require-types` promotes a coverage notice (no/unreachable types) to a failure.
	const anyCoverageGap =
		(values['require-types'] ?? false) &&
		outcomes.some((outcome) => 'result' in outcome && outcome.result.notices.length > 0);
	// An audit that could not run at all is a harder failure (exit 2) than findings (exit 1);
	// a skip is neutral, so a stray glob match never escalates a findings run into an error run.
	return anyError ? 2 : anyFinding || anyCoverageGap ? 1 : 0;
}

/** The JSON shape per target: the result, `{ target, error }`, or `{ target, skipped }`. */
function jsonEntry(
	outcome: Outcome,
): AuditResult | { target: string; error: string } | { target: string; skipped: string } {
	return 'result' in outcome ? outcome.result : outcome;
}

/** A CLI `--ignore <value>` matches a finding by package OR exact specifier. */
function cliIgnoreRules(values: string[]): IgnoreRule[] {
	return values.flatMap((value) => [{ package: value }, { specifier: value }]);
}

/** Loads `ignore` rules from a JSON config (explicit `--config`, else the default file). */
function loadConfigRules(configPath: string | undefined): IgnoreRule[] {
	const path = configPath ?? DEFAULT_CONFIG;
	const abs = resolve(path);
	if (configPath === undefined && !existsSync(abs)) {
		return [];
	}
	try {
		// Parse inside the try so a malformed JSON file gets the same `Invalid config` context.
		const parsed = JSON.parse(readFileSync(abs, 'utf8')) as { ignore?: unknown };
		return parseIgnoreRules(parsed.ignore);
	} catch (error) {
		throw new Error(`Invalid config ${path}: ${error instanceof Error ? error.message : error}`, {
			cause: error,
		});
	}
}

function printResult(result: AuditResult): void {
	const label = result.packageName ?? result.target;
	const version = result.packageVersion === undefined ? '' : `@${result.packageVersion}`;
	console.log(`\n${label}${version}  ${result.target}`);

	const resolved = result.source.resolved;
	if (resolved !== undefined) {
		// A spec/tag is a moving target — show exactly what was fetched.
		console.log(`  resolved: ${resolved.tarball}`);
		console.log(`  integrity: ${resolved.integrity}`);
	}

	if (result.ok && result.findings.length === 0 && result.notices.length === 0) {
		console.log('  ✓ no undeclared imports');
	}
	for (const notice of result.notices) {
		console.log(`  ℹ ${notice.surface.padEnd(SURFACE_WIDTH)}  ${notice.message}`);
	}
	for (const finding of result.findings) {
		console.log(findingRow('✗', finding));
		console.log(`      → ${finding.suggestion}`);
	}
	for (const finding of result.ignored) {
		console.log(findingRow('–', finding, '  — ignored'));
	}
	for (const item of result.unchecked) {
		console.log(
			`  ? ${'unchecked'.padEnd(SURFACE_WIDTH)}  ${item.specifier}  (${item.reason}; ${item.firstSeenIn})`,
		);
	}
}

const SURFACE_WIDTH = 'unchecked'.length;
const KIND_WIDTH = '[missing-types]'.length;

/**
 * One aligned finding row: `<symbol> <surface> [<kind>] <specifier> (<file>)`.
 * The headline carries the full *specifier* (e.g. `react/jsx-runtime`), not just the
 * owning package, so deep-import findings on the same package stay distinguishable.
 */
function findingRow(symbol: string, finding: Finding, suffix = ''): string {
	const surface = finding.surface.padEnd(SURFACE_WIDTH);
	const kind = `[${finding.kind}]`.padEnd(KIND_WIDTH);
	return `  ${symbol} ${surface}  ${kind}  ${finding.specifier}  (${finding.firstSeenIn})${suffix}`;
}

/** Reports a target whose audit could not run at all (acquisition/fetch failure). */
function printError(outcome: { target: string; error: string }): void {
	console.log(`\n${outcome.target}`);
	console.log(`  ⚠ error  ${outcome.error}`);
}

/** Reports a non-package path that was skipped (neutral — does not affect the exit code). */
function printSkipped(outcome: { target: string; skipped: string }): void {
	console.log(`\n${outcome.target}`);
	console.log(`  ↷ skipped  ${outcome.skipped}`);
}

function printSummary(outcomes: Outcome[]): void {
	const results = outcomes.flatMap((o) => ('result' in o ? [o.result] : []));
	const skipped = outcomes.filter((o) => 'skipped' in o).length;
	const errors = outcomes.length - results.length - skipped;
	const findings = results.reduce((sum, result) => sum + result.findings.length, 0);
	const ignored = results.reduce((sum, result) => sum + result.ignored.length, 0);
	const notices = results.reduce((sum, result) => sum + result.notices.length, 0);
	const noun = outcomes.length === 1 ? 'package' : 'packages';
	const parts = [`${findings} finding${findings === 1 ? '' : 's'}`];
	if (ignored > 0) {
		parts.push(`${ignored} ignored`);
	}
	if (notices > 0) {
		parts.push(`${notices} notice${notices === 1 ? '' : 's'}`);
	}
	if (skipped > 0) {
		parts.push(`${skipped} skipped`);
	}
	if (errors > 0) {
		parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
	}
	console.log(`\n${outcomes.length} ${noun}, ${parts.join(', ')}.`);
}

main()
	.then((code) => {
		process.exit(code);
	})
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(2);
	});
