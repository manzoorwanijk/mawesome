#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { audit } from './audit.ts';
import { parseIgnoreRules } from './ignore.ts';
import type { AuditResult, IgnoreRule } from './types.ts';

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
  --json            Emit machine-readable JSON (one AuditResult per target).
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

	// Each audit is self-contained (its own temp dirs); run targets concurrently.
	const results: AuditResult[] = await Promise.all(
		positionals.map((target) => audit(target, { ignore })),
	);

	if (values.json) {
		console.log(JSON.stringify(results, null, 2));
	} else {
		for (const result of results) {
			printResult(result);
		}
		printSummary(results);
	}

	return results.some((result) => !result.ok) ? 1 : 0;
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

	if (result.ok && result.findings.length === 0) {
		console.log('  ✓ no undeclared imports');
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

function printSummary(results: AuditResult[]): void {
	const findings = results.reduce((sum, result) => sum + result.findings.length, 0);
	const ignored = results.reduce((sum, result) => sum + result.ignored.length, 0);
	const noun = results.length === 1 ? 'package' : 'packages';
	const suffix = ignored > 0 ? `, ${ignored} ignored` : '';
	console.log(
		`\n${results.length} ${noun}, ${findings} finding${findings === 1 ? '' : 's'}${suffix}.`,
	);
}

main()
	.then((code) => {
		process.exit(code);
	})
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(2);
	});
