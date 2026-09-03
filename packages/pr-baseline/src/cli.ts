#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createClient } from './client.ts';
import { ConfigError, parseBaselines, shorthandBaselines } from './config.ts';
import { isGitHubError, RETRY_HINT } from './github/errors.ts';
import type {
	AncestryMode,
	Baseline,
	CheckResult,
	ClientOptions,
	MoveBaselineResult,
	OtherBases,
	ReportResult,
	SweepResult,
} from './types.ts';
import { BaselineError, shortSha } from './util.ts';

const VERSION = readSelfVersion();

const USAGE = `pr-baseline v${VERSION}: keep open PRs current with a movable baseline on the base branch

Usage:
  pr-baseline <command> [options]

Commands:
  check [<sha-or-ref>]   Evaluate one commit (default: HEAD of the local repository).
  sweep                  Bring every open PR's status in line with the baselines.
  move-baseline          Move baselines forward when a label, marker or --force says so.
  report                 Print every baseline, its commit and how many open PRs it binds.

Repository (flags win over env):
  --repo <owner/name>    GITHUB_REPOSITORY
  --token <token>        GITHUB_TOKEN
  --api-url <url>        GITHUB_API_URL (default https://api.github.com)
  --graphql-url <url>    GITHUB_GRAPHQL_URL (default: the GraphQL endpoint beside --api-url)
  --base <branch>        Base branch (default: the repository's default branch)

Baselines (either the JSON list or the shorthand):
  --baselines <json>     JSON array of { tag, label?, scope?, markers? }; @path reads a file
  --tag <name>           Shorthand tag (default pr-baseline)
  --label <name>         Shorthand label (default "Require PR update")
  --markers <pattern>    Shorthand auto-move pattern, repeatable

Status:
  --context <name>       Status context (default "PR baseline")
  --description-pass <text>            {base} and {tags} placeholders
  --description-fail <text>
  --description-not-applicable <text>
  --target-url <url>
  --other-bases skip|pass  PRs against other branches (default skip)
  --creator <login>      Login the token writes statuses as (resolved when omitted)

Behavior:
  --ancestry auto|git|api  Ancestry source (default auto)
  --git-dir <path>       Local repository for git ancestry and ref resolution
  --offline              Trust the local clone's tags without a token
  --max-writes-per-run <n>      Default 450
  --max-writes-per-minute <n>   Default 60
  --dry-run              Log writes instead of making them
  --json                 Print the result as JSON on stdout

check:      --pr <n>  Evaluate the PR's head; --report / --no-report  Write the status
            (reporting defaults on for --pr and off for any commit given directly).
move-baseline: --force  Move by intent alone, seeding absent tags; --to <sha>  Target commit;
            --baseline <tag>  Only this baseline; --sweep  Sweep afterwards.

Exit codes: 0 pass or complete, 1 fail or incomplete, 2 error.`;

const COMMANDS = new Set(['check', 'sweep', 'move-baseline', 'report']);

async function main(argv: string[]): Promise<number> {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(argv);
	} catch (error) {
		console.error((error as Error).message);
		console.error(USAGE);
		return 2;
	}
	const { values, positionals } = parsed;
	if (values.version) {
		console.log(VERSION);
		return 0;
	}
	if (values.help) {
		console.log(USAGE);
		return 0;
	}
	const command = positionals[0];
	if (command === undefined || !COMMANDS.has(command)) {
		console.error(USAGE);
		return 2;
	}
	if (positionals.length > (command === 'check' ? 2 : 1)) {
		console.error(`Unexpected argument "${positionals[command === 'check' ? 2 : 1]}".`);
		return 2;
	}
	if (command === 'check' && positionals[1] !== undefined && values.pr !== undefined) {
		console.error('check accepts either a commit or --pr, not both.');
		return 2;
	}
	const misplaced = misplacedOptions(command, values);
	if (misplaced.length > 0) {
		console.error(`${misplaced.join(', ')} cannot be used with "${command}".`);
		return 2;
	}

	try {
		const pr = optionalInteger(values.pr, '--pr');
		const client = createClient(clientOptions(values));
		const json = values.json ?? false;
		switch (command) {
			case 'check': {
				const result = await client.check({
					...(positionals[1] === undefined ? {} : { sha: positionals[1] }),
					...(pr === undefined ? {} : { pr }),
					...(values.report === undefined ? {} : { report: values.report }),
				});
				emit(json, result, describeCheck(result));
				return result.verdict.kind === 'fail' ? 1 : 0;
			}
			case 'sweep': {
				const result = await client.sweep();
				emit(json, result, describeSweep(result));
				return result.incomplete ? 1 : 0;
			}
			case 'move-baseline': {
				const result = await client.moveBaseline({
					force: values.force ?? false,
					sweep: values.sweep ?? false,
					...(values.to === undefined ? {} : { to: values.to }),
					...(values.baseline === undefined ? {} : { baseline: values.baseline }),
				});
				emit(json, result, describeMove(result));
				return result.sweep?.incomplete ? 1 : 0;
			}
			case 'report': {
				const result = await client.report();
				emit(json, result, describeReport(result));
				return result.offBase.length > 0 ? 2 : 0;
			}
			default:
				return 2;
		}
	} catch (error) {
		return reportError(error);
	}
}

function parse(argv: string[]) {
	return parseArgs({
		args: argv,
		allowPositionals: true,
		allowNegative: true,
		options: {
			repo: { type: 'string' },
			token: { type: 'string' },
			'api-url': { type: 'string' },
			'graphql-url': { type: 'string' },
			base: { type: 'string' },
			baselines: { type: 'string' },
			tag: { type: 'string' },
			label: { type: 'string' },
			markers: { type: 'string', multiple: true },
			baseline: { type: 'string' },
			context: { type: 'string' },
			'description-pass': { type: 'string' },
			'description-fail': { type: 'string' },
			'description-not-applicable': { type: 'string' },
			'target-url': { type: 'string' },
			ancestry: { type: 'string' },
			'git-dir': { type: 'string' },
			'other-bases': { type: 'string' },
			creator: { type: 'string' },
			offline: { type: 'boolean' },
			'max-writes-per-run': { type: 'string' },
			'max-writes-per-minute': { type: 'string' },
			'dry-run': { type: 'boolean' },
			json: { type: 'boolean' },
			pr: { type: 'string' },
			report: { type: 'boolean' },
			force: { type: 'boolean' },
			to: { type: 'string' },
			sweep: { type: 'boolean' },
			version: { type: 'boolean', short: 'v' },
			help: { type: 'boolean', short: 'h' },
		},
	});
}

type Values = ReturnType<typeof parse>['values'];

/** Command-specific options, so a flag meant for another command is an error rather than silently ignored. */
const COMMAND_OPTIONS: Record<string, readonly (keyof Values)[]> = {
	check: ['pr', 'report'],
	sweep: [],
	'move-baseline': ['force', 'to', 'baseline', 'sweep'],
	report: [],
};

function misplacedOptions(command: string, values: Values): string[] {
	const allowed = new Set<keyof Values>(COMMAND_OPTIONS[command] ?? []);
	return Object.values(COMMAND_OPTIONS)
		.flat()
		.filter((option) => !allowed.has(option) && values[option] !== undefined)
		.map((option) => `--${option}`);
}

function clientOptions(values: Values): ClientOptions {
	const options: ClientOptions = {};
	const baselines = baselineList(values);
	if (baselines !== undefined) {
		options.baselines = baselines;
	}
	assign(options, 'repo', values.repo);
	assign(options, 'token', values.token);
	assign(options, 'apiUrl', values['api-url']);
	assign(options, 'graphqlUrl', values['graphql-url']);
	assign(options, 'base', values.base);
	assign(options, 'context', values.context);
	assign(options, 'targetUrl', values['target-url']);
	assign(options, 'gitDir', values['git-dir']);
	assign(options, 'creator', values.creator);
	assign(options, 'ancestry', values.ancestry as AncestryMode | undefined);
	assign(options, 'otherBases', values['other-bases'] as OtherBases | undefined);
	assign(options, 'offline', values.offline);
	assign(options, 'dryRun', values['dry-run']);
	assign(
		options,
		'maxWritesPerRun',
		optionalInteger(values['max-writes-per-run'], '--max-writes-per-run'),
	);
	assign(
		options,
		'maxWritesPerMinute',
		optionalInteger(values['max-writes-per-minute'], '--max-writes-per-minute'),
	);
	const descriptions: NonNullable<ClientOptions['descriptions']> = {};
	assign(descriptions, 'pass', values['description-pass']);
	assign(descriptions, 'fail', values['description-fail']);
	assign(descriptions, 'notApplicable', values['description-not-applicable']);
	if (Object.keys(descriptions).length > 0) {
		options.descriptions = descriptions;
	}
	return options;
}

function baselineList(values: Values): Baseline[] | undefined {
	const shorthand =
		values.tag !== undefined || values.label !== undefined || values.markers !== undefined;
	if (values.baselines !== undefined) {
		if (shorthand) {
			throw new ConfigError('--baselines cannot be combined with --tag, --label or --markers.');
		}
		return parseBaselines(values.baselines, (path) => readFileSync(path, 'utf8'));
	}
	if (!shorthand) {
		return undefined;
	}
	return shorthandBaselines({ tag: values.tag, label: values.label, markers: values.markers });
}

function assign<T extends object, K extends keyof T>(
	target: T,
	key: K,
	value: T[K] | undefined,
): void {
	if (value !== undefined) {
		target[key] = value;
	}
}

function optionalInteger(value: string | undefined, flag: string): number | undefined {
	return value === undefined ? undefined : integer(value, flag);
}

function integer(value: string, flag: string): number {
	if (!/^\d+$/.test(value)) {
		throw new ConfigError(`${flag} expects a non-negative integer, got "${value}".`);
	}
	return Number(value);
}

function emit(json: boolean, result: unknown, text: string): void {
	console.log(json ? JSON.stringify(result, null, 2) : text);
}

function describeCheck(result: CheckResult): string {
	const { verdict } = result;
	const action = result.written ? 'written' : result.skipped ? 'already current' : 'not written';
	return `${shortSha(result.sha)} against ${result.base}: ${verdict.kind} (${verdict.status.description}); status ${action}.`;
}

function describeSweep(result: SweepResult): string {
	const line = `Sweep of ${result.openPulls} open PRs against ${result.base}: ${result.written} written, ${result.skipped} skipped, ${result.closed} closed, ${result.deferred} deferred, ${result.failed} failed.`;
	return result.incomplete ? `${line} Incomplete (${result.reason}). ${RETRY_HINT}` : line;
}

function describeMove(result: MoveBaselineResult): string {
	const lines = result.moves.map((move) => {
		const from = move.from === null ? 'absent' : shortSha(move.from);
		return move.moved
			? `${move.tag}: ${from} -> ${shortSha(move.to)} (${move.reason})`
			: `${move.tag}: unchanged at ${from} (${move.note})`;
	});
	if (result.sweep) {
		lines.push(describeSweep(result.sweep));
	}
	return lines.join('\n');
}

function describeReport(result: ReportResult): string {
	const lines = [`${result.base} at ${shortSha(result.head)}; ${result.openPulls} open PRs.`];
	for (const baseline of result.baselines) {
		const where = baseline.sha === null ? 'absent' : shortSha(baseline.sha);
		const onBase = baseline.onBase === null ? '' : baseline.onBase ? ', on base' : ', NOT on base';
		lines.push(`${baseline.tag}: ${where}${onBase}; binds ${baseline.bound} open PRs.`);
	}
	if (result.offBase.length > 0) {
		lines.push(
			`Baseline ${result.offBase.join(', ')} is not on ${result.base}; fix the tag before sweeping.`,
		);
	}
	return lines.join('\n');
}

function reportError(error: unknown): number {
	if (error instanceof ConfigError || error instanceof BaselineError) {
		console.error(error.message);
		return 2;
	}
	if (isGitHubError(error)) {
		console.error(error.kind === 'rate-limit' ? `${error.message} ${RETRY_HINT}` : error.message);
		return 2;
	}
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	return 2;
}

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

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	process.exitCode = reportError(error);
}
