#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { audit } from './audit.ts';
import { mapLimit } from './concurrency.ts';
import { parseIgnoreRules } from './ignore.ts';
import type { AuditResult, IgnoreRule } from './types.ts';

/** Max targets audited in parallel; each target itself fans out to its own deps. */
const TARGET_CONCURRENCY = 6;

/** A target that produced a result, or one that failed to audit (isolated, never fatal). */
type Outcome = { target: string; result: AuditResult } | { target: string; error: string };

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
	// An audit that could not run at all is a harder failure (exit 2) than findings (exit 1).
	return anyError ? 2 : anyFinding || anyCoverageGap ? 1 : 0;
}

/** The JSON shape per target: the full result, or `{ target, error }` for a failed audit. */
function jsonEntry(outcome: Outcome): AuditResult | { target: string; error: string } {
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
	const parsed = JSON.parse(readFileSync(abs, 'utf8')) as { ignore?: unknown };
	try {
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
		console.log(`  ℹ ${notice.surface}  ${notice.message}`);
	}
	for (const finding of result.findings) {
		console.log(
			`  ✗ ${finding.surface}  ${finding.packageName}  [${finding.kind}]  ${finding.firstSeenIn}`,
		);
		console.log(`      → ${finding.suggestion}`);
	}
	for (const finding of result.ignored) {
		console.log(
			`  – ignored  ${finding.surface}  ${finding.packageName}  [${finding.kind}]  ${finding.firstSeenIn}`,
		);
	}
	for (const item of result.unchecked) {
		console.log(`  ? unchecked  ${item.specifier}  (${item.reason})  ${item.firstSeenIn}`);
	}
}

/** Reports a target whose audit could not run at all (acquisition/fetch failure). */
function printError(outcome: { target: string; error: string }): void {
	console.log(`\n${outcome.target}`);
	console.log(`  ⚠ error  ${outcome.error}`);
}

function printSummary(outcomes: Outcome[]): void {
	const results = outcomes.flatMap((o) => ('result' in o ? [o.result] : []));
	const errors = outcomes.length - results.length;
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
