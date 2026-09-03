import { createWriteBudget } from '../budget.ts';
import { ConfigError } from '../config.ts';
import { baselinesOffBase, evaluateCommit } from '../evaluate.ts';
import { isGitHubError, RETRY_HINT } from '../github/errors.ts';
import { listOpenPulls, type OpenPull } from '../github/pulls.ts';
import type { Runtime } from '../runtime.ts';
import type {
	Reporter,
	ResolvedBaseline,
	SweepEntry,
	SweepResult,
	SweepStopReason,
	Verdict,
} from '../types.ts';
import { BaselineError } from '../util.ts';
import { writeWithRetries } from '../reporter/write.ts';
import { statusMatches, type VerdictContext } from '../verdict.ts';

export interface SweepInput {
	/** Baselines already resolved by the caller, as after a move or in a dry run. */
	baselines?: ResolvedBaseline[];
}

interface Setup {
	base: string;
	creator: string;
	reporter: Reporter;
	baselines: ResolvedBaseline[];
	baseHead: string;
	pulls: OpenPull[];
}

/** Brings every in-scope open PR's status in line with the current baselines, writing only changes. */
export async function runSweep(runtime: Runtime, input: SweepInput = {}): Promise<SweepResult> {
	const { config, ancestry, api, logger } = runtime;
	const budget = createWriteBudget({
		maxWritesPerRun: config.maxWritesPerRun,
		maxWritesPerMinute: config.maxWritesPerMinute,
		now: runtime.now,
	});
	const entries: SweepEntry[] = [];
	const counts = { written: 0, skipped: 0, closed: 0, deferred: 0, failed: 0 };
	let reason: SweepStopReason | undefined;
	const finish = (base: string, baselines: ResolvedBaseline[], openPulls: number): SweepResult => {
		const incomplete = reason !== undefined || counts.deferred > 0 || counts.failed > 0;
		if (incomplete && reason === undefined) {
			reason = counts.deferred > 0 ? 'deferred' : 'failed';
		}
		if (incomplete) {
			logger.warn(`Sweep incomplete (${reason}). ${RETRY_HINT}`);
		}
		return {
			base,
			baselines,
			openPulls,
			...counts,
			incomplete,
			...(reason === undefined ? {} : { reason }),
			entries,
			ancestry: ancestry.name,
			dryRun: config.dryRun,
		};
	};

	let setup: Setup;
	let resolvedBase: string | undefined;
	let resolvedBaselines: ResolvedBaseline[] | undefined = input.baselines;
	try {
		const base = await runtime.base();
		resolvedBase = base;
		// Resolved before any evaluation so a creator problem is a configuration error, not a partial sweep.
		const creator = await runtime.creator();
		const reporter = await runtime.reporter();
		const baselines = input.baselines ?? (await runtime.readBaselines());
		resolvedBaselines = baselines;
		const baseHead = await runtime.head();
		const off = await baselinesOffBase(ancestry, baselines, baseHead);
		if (off.length > 0) {
			throw new BaselineError(
				`Baseline ${off.join(', ')} is not an ancestor of ${base}; fix the tag before sweeping.`,
			);
		}
		const pulls = await listOpenPulls(api, config.repo, { base, context: config.context });
		setup = { base, creator, reporter, baselines, baseHead, pulls };
	} catch (error) {
		// A limit hit while reading still owes the operator the retry guidance.
		if (isGitHubError(error, 'rate-limit')) {
			logger.warn(error.message);
			reason = 'rate-limit';
			return finish(resolvedBase ?? config.base ?? '', resolvedBaselines ?? [], 0);
		}
		throw error;
	}
	const { base, creator, reporter, baselines, baseHead } = setup;
	const context: VerdictContext = {
		base,
		descriptions: config.descriptions,
		targetUrl: config.targetUrl,
	};
	const inScope = setup.pulls.filter(
		(pull) => pull.baseRef === base && (config.includeDrafts || !pull.isDraft),
	);
	logger.info(
		`Base ${base} at ${baseHead.slice(0, 12)}; ${inScope.length} open PRs; ${describe(baselines)}.`,
	);

	// Statuses belong to commits, so a head shared by several PRs is processed once, failures included.
	const settled = new Map<string, { verdict?: Verdict; error?: unknown }>();
	for (const pull of inScope) {
		const shared = settled.get(pull.headSha);
		if (shared !== undefined) {
			if (shared.error === undefined) {
				counts.skipped++;
				entries.push(entry(pull, 'skipped', shared.verdict));
			} else {
				counts.failed++;
				entries.push(entry(pull, 'failed', shared.verdict, shared.error));
			}
			continue;
		}
		/* Probed first so an unwritable PR costs no ancestry request. */
		const probe = budget.next(api.rest.remaining);
		if (!probe.ok) {
			reason = probe.reason;
			break;
		}
		let verdict: Verdict;
		let current;
		try {
			verdict = await evaluateCommit({
				ancestry,
				baselines,
				sha: pull.headSha,
				baseHead,
				context,
				logger,
			});
			// The listing already carries the commit status the built-in reporter would read; a custom reporter is asked.
			current = runtime.customReporter ? await reporter.current(pull.headSha) : pull.status;
		} catch (error) {
			if (isGitHubError(error, 'rate-limit')) {
				reason = 'rate-limit';
				break;
			}
			counts.failed++;
			entries.push(entry(pull, 'failed', undefined, error));
			settled.set(pull.headSha, { error });
			continue;
		}
		if (statusMatches(current, verdict.status, creator)) {
			settled.set(pull.headSha, { verdict });
			counts.skipped++;
			entries.push(entry(pull, 'skipped', verdict));
			continue;
		}
		try {
			const outcome = await writeWithRetries(reporter, pull.headSha, verdict.status, {
				// Every physical attempt is budgeted and paced; the transport itself does not retry writes.
				async before() {
					const decision = budget.next(api.rest.remaining);
					if (!decision.ok) {
						reason = decision.reason;
						return false;
					}
					if (decision.waitMs > 0 && !config.dryRun) {
						await runtime.sleep(decision.waitMs);
					}
					budget.record();
					return true;
				},
				sleep: runtime.sleep,
				retryBaseMs: config.retryBaseMs,
			});
			if (outcome === 'abandoned') {
				break;
			}
			settled.set(pull.headSha, { verdict });
			counts.written++;
			entries.push(entry(pull, 'written', verdict));
		} catch (error) {
			// A creator mismatch is an identity problem that repeats for every PR; the run fails outright.
			if (error instanceof ConfigError) {
				throw error;
			}
			counts.failed++;
			entries.push(entry(pull, 'failed', verdict, error));
			settled.set(pull.headSha, { verdict, error });
			logger.warn(`PR #${pull.number}: ${message(error)}`);
			if (isGitHubError(error, 'rate-limit')) {
				reason = 'rate-limit';
				break;
			}
			// A permission or auth failure repeats for every PR; stop instead of burning the budget.
			if (isGitHubError(error, 'permission') || isGitHubError(error, 'auth')) {
				reason = 'failed';
				break;
			}
		}
	}
	return finish(base, baselines, inScope.length);
}

function entry(
	pull: OpenPull,
	outcome: SweepEntry['outcome'],
	verdict?: SweepEntry['verdict'],
	error?: unknown,
): SweepEntry {
	return {
		number: pull.number,
		sha: pull.headSha,
		outcome,
		...(verdict === undefined ? {} : { verdict }),
		...(error === undefined ? {} : { error: message(error) }),
	};
}

function describe(baselines: ResolvedBaseline[]): string {
	return baselines
		.map(
			(baseline) =>
				`${baseline.tag}=${baseline.sha === null ? 'absent' : baseline.sha.slice(0, 12)}`,
		)
		.join(', ');
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
