import { ConfigError } from '../config.ts';
import { listLabeledMergeCommits } from '../github/pulls.ts';
import { resolveCommit } from '../github/refs.ts';
import { createMatcher } from '../paths.ts';
import { describeError, selectRefWriter, warnQuietly, type RefWriter } from '../ref-writer.ts';
import type { Runtime } from '../runtime.ts';
import type {
	Ancestry,
	MoveBaselineOptions,
	MoveBaselineResult,
	MoveEntry,
	MoveReason,
	ResolvedBaseline,
} from '../types.ts';
import { BaselineError, refSnapshot, shortSha } from '../util.ts';
import { runRefreshPrStatuses } from './refresh-pr-statuses.ts';

type Decision = { reason: MoveReason } | { note: string };

/** Moves each selected baseline forward when there is intent to, then optionally refreshes. */
export async function runMoveBaseline(
	runtime: Runtime,
	options: MoveBaselineOptions,
): Promise<MoveBaselineResult> {
	const { config, api, logger } = runtime;
	if (config.offline) {
		throw new ConfigError(
			'move-baseline needs the API; --offline applies to refresh-pr-status only.',
		);
	}
	const ancestry = await runtime.ancestry();
	/* The writer is chosen at the first write, after preparation may have switched the adapter to the API.
	 * `--ancestry api` means no git at all, so it also keeps the writes on the refs API. */
	let writer: RefWriter | undefined;
	const refWriter = async (): Promise<RefWriter> => {
		writer ??= selectRefWriter(ancestry.name === 'git' ? await runtime.repo() : null, {
			api,
			repo: config.repo,
			serverUrl: config.serverUrl,
			token: config.token,
			logger,
			allowGit: config.ancestry !== 'api',
		});
		return writer;
	};
	if (
		options.baseline !== undefined &&
		options.baseline !== '' &&
		!config.baselines.some((baseline) => baseline.name === options.baseline)
	) {
		throw new ConfigError(`No configured baseline is named "${options.baseline}".`);
	}
	const base = await runtime.base();
	if (options.refreshPrStatuses) {
		// Resolved before anything moves so a creator problem is a configuration error, not a half-run.
		await runtime.creator();
	}
	const baselines = await runtime.readBaselines();
	const before = refSnapshot(baselines);
	const selected = select(baselines, options.baseline);
	const head = await runtime.head();
	// One base-head read per run: a `--to` is resolved separately, the default target is that same head.
	const target =
		options.to === undefined || options.to === ''
			? head
			: await resolveCommit(runtime.api, runtime.config.repo, options.to);
	const prepare = (shas: string[]) =>
		ancestry.prepare?.({ shas, pulls: [], refs: refSnapshot(baselines) });
	// Preparation verifies the baseline refs and fetches the commits before any ancestry question is asked.
	await prepare([head, target]);
	if (target !== head && !(await ancestry.isAncestor(target, head))) {
		throw new BaselineError(
			`Target ${shortSha(target)} is not on ${base}; a baseline must be reachable from the base branch.`,
		);
	}
	const force = options.force ?? false;
	// A forced move or a baseline already at the target decides without the label scan.
	const candidates = force ? [] : selected.filter((baseline) => baseline.sha !== target);
	const labeled = await labeledMerges(runtime, base, candidates);
	const candidateMerges = [...labeled.values()].flat();
	if (candidateMerges.length > 0) {
		await prepare(candidateMerges);
	}

	const moves: MoveEntry[] = [];
	try {
		for (const baseline of selected) {
			const move = await moveOne(baseline, target, labeled, force);
			moves.push(move);
			// `from` already reflects a re-read after a lost race, so it is the truth when nothing moved.
			baseline.sha = move.moved ? move.to : move.from;
			logger.info(describe(move));
		}
	} finally {
		// Cleanup is worth a warning, never a failure: the moves it could mask have already landed.
		await writer?.close?.().catch((error: unknown) => {
			warnQuietly(logger, `Could not remove the temporary repository (${describeError(error)}).`);
		});
	}

	/*
	 * Another writer may have advanced a baseline between this run's successful update and now.
	 * The refs are re-read so the result and the refresh see the authoritative SHAs; a dry run keeps its intended ones.
	 */
	const authoritative = config.dryRun ? baselines : await runtime.readBaselines();
	const result: MoveBaselineResult = {
		base,
		head: target,
		baselines: authoritative,
		moves,
		dryRun: config.dryRun,
	};
	if (options.refreshPrStatuses) {
		/* Scoping to green PRs is sound only because a baseline moves forward: a forced move can put one
		 * anywhere, so it can turn a red PR green, which only a full sweep sees. */
		const forced = moves.some((move) => move.moved && move.reason === 'forced');
		// A dry-run refresh evaluates statuses against the intended positions while the adapter still verifies the real, unmoved refs.
		result.refresh = await runRefreshPrStatuses(runtime, {
			baselines: authoritative,
			...(forced ? { scope: 'all' as const } : {}),
			...(config.dryRun ? { verifyRefs: before } : {}),
		});
	}
	return result;

	async function moveOne(
		baseline: ResolvedBaseline,
		to: string,
		merges: Map<string, string[]>,
		forced: boolean,
	): Promise<MoveEntry> {
		let current = baseline.sha;
		for (let attempt = 1; ; attempt++) {
			if (current === to) {
				return {
					name: baseline.name,
					from: current,
					to,
					moved: false,
					note: 'already at the target',
				};
			}
			// After a lost race the other writer may have gone past the target, which is not a rewind to refuse.
			if (attempt > 1 && current !== null && (await ancestry.isAncestor(to, current))) {
				return {
					name: baseline.name,
					from: current,
					to,
					moved: false,
					note: 'another writer moved it past the target',
				};
			}
			// A baseline off the base branch is unsatisfiable, so a forced move onto it repairs rather than rewinds.
			const onBase = current === null || (await ancestry.isAncestor(current, head));
			const decision = await decide(ancestry, baseline, current, to, merges, forced, onBase);
			if ('note' in decision) {
				return { name: baseline.name, from: current, to, moved: false, note: decision.note };
			}
			if (current !== null && !(await ancestry.isAncestor(current, to))) {
				if (onBase) {
					throw new BaselineError(
						`Refusing to move ${baseline.name}: ${shortSha(to)} does not descend from ${shortSha(current)}.`,
					);
				}
				logger.warn(
					`${baseline.name} was not on ${base} at ${shortSha(current)}; the forced move puts it back.`,
				);
			}
			if (config.dryRun) {
				return { name: baseline.name, from: current, to, moved: true, reason: decision.reason };
			}
			const outcome = await (await refWriter()).move(baseline.name, current, to);
			if (outcome.ok) {
				return {
					name: baseline.name,
					from: current,
					to,
					moved: true,
					reason: decision.reason,
					via: outcome.via,
				};
			}
			const latest = outcome.actual;
			if (attempt > 1) {
				throw new BaselineError(
					`${baseline.name} moved twice during this run (now ${latest === null ? 'absent' : shortSha(latest)}); rerun to converge.`,
				);
			}
			logger.warn(
				`${baseline.name} moved to ${latest === null ? 'absent' : shortSha(latest)} while this run was deciding; re-evaluating once.`,
			);
			current = latest;
			// The re-read commit is new to the adapter and must be prepared before any question about it.
			baseline.sha = latest;
			if (latest !== null) {
				await prepare([latest]);
			}
		}
	}
}

/** Whether a baseline should move from `current` to `target`, and why. */
async function decide(
	ancestry: Ancestry,
	baseline: ResolvedBaseline,
	current: string | null,
	target: string,
	merges: Map<string, string[]>,
	force: boolean,
	onBase: boolean,
): Promise<Decision> {
	if (force) {
		return { reason: 'forced' };
	}
	if (current === null) {
		return { note: 'absent; seed it with --force' };
	}
	if (!onBase) {
		/* The label and marker scans below compare against the base branch, which this baseline left,
		 * so their answer would be meaningless; only an operator can say where the baseline belongs. */
		return { note: 'not on the base branch; repair it with a forced move' };
	}
	if (baseline.label !== undefined) {
		for (const oid of merges.get(baseline.label) ?? []) {
			if (
				oid !== current &&
				(await ancestry.isAncestor(current, oid)) &&
				(await ancestry.isAncestor(oid, target))
			) {
				return { reason: 'label' };
			}
		}
	}
	if (baseline.markers !== undefined) {
		const files = await ancestry.changedFiles(current, target);
		if (files === null) {
			return {
				note: 'changed files since the baseline are indeterminate; not moving automatically',
			};
		}
		if (createMatcher(baseline.markers).touches(files)) {
			return { reason: 'markers' };
		}
	}
	return { note: 'no labeled merge or marker change since the baseline' };
}

/** One exhaustive scan per distinct label, shared by every baseline carrying it. */
async function labeledMerges(
	runtime: Runtime,
	base: string,
	baselines: ResolvedBaseline[],
): Promise<Map<string, string[]>> {
	const merges = new Map<string, string[]>();
	for (const baseline of baselines) {
		if (baseline.label === undefined || merges.has(baseline.label) || baseline.sha === null) {
			continue;
		}
		const oids = await listLabeledMergeCommits(runtime.api, runtime.config.repo, {
			base,
			label: baseline.label,
		});
		merges.set(baseline.label, [...new Set(oids)]);
	}
	return merges;
}

function select(baselines: ResolvedBaseline[], name: string | undefined): ResolvedBaseline[] {
	if (name === undefined || name === '') {
		return baselines;
	}
	const match = baselines.filter((baseline) => baseline.name === name);
	if (match.length === 0) {
		throw new ConfigError(`No configured baseline is named "${name}".`);
	}
	return match;
}

function describe(move: MoveEntry): string {
	const from = move.from === null ? 'absent' : shortSha(move.from);
	if (move.moved) {
		return `${move.name}: ${from} -> ${shortSha(move.to)} (${move.reason}).`;
	}
	return `${move.name}: unchanged at ${from}; ${move.note}.`;
}
