import { ConfigError } from '../config.ts';
import { baselinesOffBase, evaluateCommit } from '../evaluate.ts';
import { tryRevParse } from '../git/local.ts';
import { getPull } from '../github/pulls.ts';
import { resolveCommit } from '../github/refs.ts';
import type { Runtime } from '../runtime.ts';
import type { CheckOptions, CheckResult, ResolvedBaseline, Verdict } from '../types.ts';
import { writeWithRetries } from '../reporter/write.ts';
import { isFullSha } from '../util.ts';
import {
	misconfiguredVerdict,
	notApplicableVerdict,
	statusMatches,
	type VerdictContext,
} from '../verdict.ts';

/** Snapshot reads before posting; the refs almost never move twice within one check. */
const SNAPSHOT_ROUNDS = 3;

interface Target {
	sha: string;
	/** The PR's base branch when a PR was given. */
	baseRef: string | undefined;
	/** Whether reporting defaults on: only a PR is known to come from an event; any bare commit is a local question. */
	fromEvent: boolean;
}

/** Evaluates one commit and, when reporting, brings its status up to date. */
export async function runCheck(runtime: Runtime, options: CheckOptions): Promise<CheckResult> {
	const { config, ancestry, api, logger } = runtime;
	if (options.pr !== undefined && options.sha !== undefined) {
		throw new ConfigError('check accepts either a commit or --pr, not both.');
	}
	const base = await runtime.base();
	const target = await resolveTarget(runtime, options);
	const report = options.report ?? target.fromEvent;
	const context: VerdictContext = {
		base,
		descriptions: config.descriptions,
		targetUrl: config.targetUrl,
	};
	const result = (verdict: Verdict, baselines: ResolvedBaseline[]): CheckResult => ({
		sha: target.sha,
		base,
		verdict,
		baselines,
		written: false,
		skipped: false,
		outOfScope: false,
		ancestry: ancestry.name,
	});

	let baselines = await runtime.readBaselines();
	if (target.baseRef !== undefined && target.baseRef !== base) {
		const verdict = notApplicableVerdict(context);
		if (config.otherBases === 'skip' || !report) {
			logger.info(`PR targets ${target.baseRef}, not ${base}; no status written.`);
			return { ...result(verdict, baselines), outOfScope: true };
		}
		return {
			...(await write(runtime, target.sha, verdict, result(verdict, baselines))),
			outOfScope: true,
		};
	}
	if (report) {
		// Resolved before any evaluation so a creator problem is a configuration error, not a late surprise.
		await runtime.creator();
	}

	let baseHead = await resolveCommit(api, config.repo, base);
	const evaluate = (list: ResolvedBaseline[], head: string) =>
		evaluateWithGuard({ runtime, baselines: list, sha: target.sha, baseHead: head, context });
	let verdict = await evaluate(baselines, baseHead);
	if (!report) {
		return result(verdict, baselines);
	}

	/*
	 * Before posting, the tags and then the base head are read again until two consecutive snapshots agree.
	 * A move that lands between a tag read and a head read would otherwise pair an old baseline with a new head.
	 */
	for (let round = 1; round <= SNAPSHOT_ROUNDS; round++) {
		const latest = await runtime.readBaselines();
		const latestHead = await resolveCommit(api, config.repo, base);
		const same =
			latestHead === baseHead &&
			latest.every((entry, index) => entry.sha === baselines[index]?.sha);
		if (same) {
			break;
		}
		baselines = latest;
		baseHead = latestHead;
		verdict = await evaluate(baselines, baseHead);
		if (round === SNAPSHOT_ROUNDS) {
			logger.warn(
				'The baselines kept moving during this check; the next sweep converges the result.',
			);
		}
	}
	return write(runtime, target.sha, verdict, result(verdict, baselines));
}

/** A baseline that left the base branch yields a misconfiguration pass instead of any verdict. */
async function evaluateWithGuard(input: {
	runtime: Runtime;
	baselines: ResolvedBaseline[];
	sha: string;
	baseHead: string;
	context: VerdictContext;
}): Promise<Verdict> {
	const { runtime, baselines, sha, baseHead, context } = input;
	const off = await baselinesOffBase(runtime.ancestry, baselines, baseHead);
	if (off.length > 0) {
		runtime.logger.warn(
			`Baseline ${off.join(', ')} is not on ${context.base}; posting a pass instead of blocking.`,
		);
		return misconfiguredVerdict(off, context);
	}
	return evaluateCommit({
		ancestry: runtime.ancestry,
		baselines,
		sha,
		baseHead,
		context,
		logger: runtime.logger,
	});
}

async function write(
	runtime: Runtime,
	sha: string,
	verdict: Verdict,
	result: CheckResult,
): Promise<CheckResult> {
	const creator = await runtime.creator();
	const reporter = await runtime.reporter();
	const current = await reporter.current(sha);
	if (statusMatches(current, verdict.status, creator)) {
		runtime.logger.info(`Status already current (${verdict.status.state}); nothing written.`);
		return { ...result, skipped: true };
	}
	await writeWithRetries(reporter, sha, verdict.status, {
		before: () => Promise.resolve(true),
		sleep: runtime.sleep,
		retryBaseMs: runtime.config.retryBaseMs,
	});
	return { ...result, written: true };
}

async function resolveTarget(runtime: Runtime, options: CheckOptions): Promise<Target> {
	const { api, config } = runtime;
	if (options.pr !== undefined) {
		const pull = await getPull(api, config.repo, options.pr);
		if (pull === null) {
			throw new ConfigError(`Pull request #${options.pr} was not found in ${config.repo}.`);
		}
		return { sha: pull.headSha, baseRef: pull.baseRef, fromEvent: true };
	}
	if (options.sha !== undefined) {
		if (isFullSha(options.sha)) {
			return { sha: options.sha.toLowerCase(), baseRef: undefined, fromEvent: false };
		}
		const local = tryRevParse(options.sha, config.gitDir);
		const sha = local ?? (await resolveCommit(api, config.repo, options.sha));
		return { sha, baseRef: undefined, fromEvent: false };
	}
	const head = tryRevParse('HEAD', config.gitDir);
	if (head === null) {
		throw new ConfigError(
			'check needs a commit: pass a SHA or ref, --pr, or run inside a git repository.',
		);
	}
	return { sha: head, baseRef: undefined, fromEvent: false };
}
