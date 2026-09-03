import { ConfigError } from '../config.ts';
import { isGitHubError } from '../github/errors.ts';
import { listLabeledMergeCommits } from '../github/pulls.ts';
import { createTag, fastForwardTag, readTag, resolveCommit } from '../github/refs.ts';
import { createMatcher } from '../paths.ts';
import type { Runtime } from '../runtime.ts';
import type {
	MoveBaselineOptions,
	MoveBaselineResult,
	MoveEntry,
	MoveReason,
	ResolvedBaseline,
} from '../types.ts';
import { BaselineError, shortSha } from '../util.ts';
import { runSweep } from './sweep.ts';

type Decision = { reason: MoveReason } | { note: string };

/** Moves each selected baseline forward when there is intent to, then optionally sweeps. */
export async function runMoveBaseline(
	runtime: Runtime,
	options: MoveBaselineOptions,
): Promise<MoveBaselineResult> {
	const { config, ancestry, api, logger } = runtime;
	if (
		options.baseline !== undefined &&
		options.baseline !== '' &&
		!config.baselines.some((baseline) => baseline.tag === options.baseline)
	) {
		throw new ConfigError(`No configured baseline has the tag "${options.baseline}".`);
	}
	const base = await runtime.base();
	if (options.sweep) {
		// Resolved before anything moves so a creator problem is a configuration error, not a half-run.
		await runtime.creator();
	}
	const baselines = await runtime.readBaselines();
	const selected = select(baselines, options.baseline);
	const target = await resolveTarget(runtime, base, options.to);
	const force = options.force ?? false;
	// A forced move or a baseline already at the target decides without the label scan.
	const candidates = force ? [] : selected.filter((baseline) => baseline.sha !== target);
	const labeled = await labeledMerges(runtime, base, candidates);

	const moves: MoveEntry[] = [];
	for (const baseline of selected) {
		const move = await moveOne(runtime, baseline, target, labeled, force);
		moves.push(move);
		// `from` already reflects a re-read after a lost race, so it is the truth when nothing moved.
		baseline.sha = move.moved ? move.to : move.from;
		logger.info(describe(move));
	}

	/*
	 * Another writer may have advanced a tag between this run's successful update and now.
	 * The refs are re-read so the result and the sweep see the authoritative SHAs; a dry run keeps its intended ones.
	 */
	const authoritative = config.dryRun ? baselines : await runtime.readBaselines();
	const result: MoveBaselineResult = {
		base,
		head: target,
		baselines: authoritative,
		moves,
		dryRun: config.dryRun,
	};
	if (options.sweep) {
		result.sweep = await runSweep(runtime, { baselines: authoritative });
	}
	return result;

	async function moveOne(
		rt: Runtime,
		baseline: ResolvedBaseline,
		to: string,
		merges: Map<string, string[]>,
		forced: boolean,
	): Promise<MoveEntry> {
		let current = baseline.sha;
		for (let attempt = 1; ; attempt++) {
			if (current === to) {
				return {
					tag: baseline.tag,
					from: current,
					to,
					moved: false,
					note: 'already at the target',
				};
			}
			const decision = await decide(rt, baseline, current, to, merges, forced);
			if ('note' in decision) {
				return { tag: baseline.tag, from: current, to, moved: false, note: decision.note };
			}
			if (current !== null && !(await ancestry.isAncestor(current, to))) {
				throw new BaselineError(
					`Refusing to move ${baseline.tag}: ${shortSha(to)} does not descend from ${shortSha(current)}.`,
				);
			}
			if (config.dryRun) {
				return { tag: baseline.tag, from: current, to, moved: true, reason: decision.reason };
			}
			try {
				if (current === null) {
					await createTag(api, config.repo, baseline.tag, to);
				} else {
					await fastForwardTag(api, config.repo, baseline.tag, to);
				}
				return { tag: baseline.tag, from: current, to, moved: true, reason: decision.reason };
			} catch (error) {
				if (!isGitHubError(error, 'conflict') && !isGitHubError(error, 'validation')) {
					throw error;
				}
				// A rejected update means either another writer moved the tag or the request was invalid.
				const latest = await readTag(api, config.repo, baseline.tag);
				if (latest === current) {
					throw error;
				}
				if (attempt > 1) {
					throw new BaselineError(
						`${baseline.tag} moved twice during this run (now ${latest === null ? 'absent' : shortSha(latest)}); rerun to converge.`,
					);
				}
				logger.warn(
					`${baseline.tag} moved to ${latest === null ? 'absent' : shortSha(latest)} while this run was deciding; re-evaluating once.`,
				);
				current = latest;
			}
		}
	}
}

/** Whether a baseline should move from `current` to `target`, and why. */
async function decide(
	runtime: Runtime,
	baseline: ResolvedBaseline,
	current: string | null,
	target: string,
	merges: Map<string, string[]>,
	force: boolean,
): Promise<Decision> {
	if (force) {
		return { reason: 'forced' };
	}
	if (current === null) {
		return { note: 'tag is absent; seed it with --force' };
	}
	if (baseline.label !== undefined) {
		for (const oid of merges.get(baseline.label) ?? []) {
			if (
				oid !== current &&
				(await runtime.ancestry.isAncestor(current, oid)) &&
				(await runtime.ancestry.isAncestor(oid, target))
			) {
				return { reason: 'label' };
			}
		}
	}
	if (baseline.markers !== undefined) {
		const files = await runtime.ancestry.changedFiles(current, target);
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

function select(baselines: ResolvedBaseline[], tag: string | undefined): ResolvedBaseline[] {
	if (tag === undefined || tag === '') {
		return baselines;
	}
	const match = baselines.filter((baseline) => baseline.tag === tag);
	if (match.length === 0) {
		throw new ConfigError(`No configured baseline has the tag "${tag}".`);
	}
	return match;
}

async function resolveTarget(
	runtime: Runtime,
	base: string,
	to: string | undefined,
): Promise<string> {
	const head = await runtime.head();
	if (to === undefined || to === '') {
		return head;
	}
	const target = await resolveCommit(runtime.api, runtime.config.repo, to);
	if (!(await runtime.ancestry.isAncestor(target, head))) {
		throw new BaselineError(
			`Target ${shortSha(target)} is not on ${base}; a baseline must be reachable from the base branch.`,
		);
	}
	return target;
}

function describe(move: MoveEntry): string {
	const from = move.from === null ? 'absent' : shortSha(move.from);
	if (move.moved) {
		return `${move.tag}: ${from} -> ${shortSha(move.to)} (${move.reason}).`;
	}
	return `${move.tag}: unchanged at ${from}; ${move.note}.`;
}
