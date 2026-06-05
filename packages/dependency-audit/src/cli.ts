#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { audit } from './audit.ts';
import type { AuditResult } from './types.ts';

const USAGE = `dependency-audit — verify a package's released imports are all declared

Usage:
  dependency-audit [options] <target...>

A target is a package directory, a .tgz path, a published spec (name@version,
name@tag, @scope/name), or an http(s) tarball URL.

Options:
  --json      Emit machine-readable JSON (one AuditResult per target).
  -h, --help  Show this help.

Exit codes: 0 = clean, 1 = findings, 2 = error.`;

async function main(): Promise<number> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			json: { type: 'boolean', default: false },
			help: { type: 'boolean', short: 'h', default: false },
		},
	});

	if (values.help) {
		console.log(USAGE);
		return 0;
	}
	if (positionals.length === 0) {
		console.error(USAGE);
		return 2;
	}

	// Each audit is self-contained (its own temp dirs); run targets concurrently.
	const results: AuditResult[] = await Promise.all(positionals.map((target) => audit(target)));

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

	if (result.ok) {
		console.log('  ✓ no undeclared imports');
	}
	for (const finding of result.findings) {
		console.log(
			`  ✗ ${finding.surface}  ${finding.packageName}  [${finding.kind}]  ${finding.firstSeenIn}`,
		);
		console.log(`      → ${finding.suggestion}`);
	}
	for (const item of result.unchecked) {
		console.log(`  ? unchecked  ${item.specifier}  (${item.reason})  ${item.firstSeenIn}`);
	}
}

function printSummary(results: AuditResult[]): void {
	const findings = results.reduce((sum, result) => sum + result.findings.length, 0);
	const noun = results.length === 1 ? 'package' : 'packages';
	console.log(`\n${results.length} ${noun}, ${findings} finding${findings === 1 ? '' : 's'}.`);
}

main()
	.then((code) => {
		process.exit(code);
	})
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(2);
	});
