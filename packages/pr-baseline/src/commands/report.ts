import { applicableBaselines, evaluateCommit } from '../evaluate.ts';
import { ConfigError, repoUrl } from '../config.ts';
import type { OpenPull } from '../github/pulls.ts';
import type { Ancestry, ResolvedBaseline } from '../types.ts';
import { refSnapshot } from '../util.ts';
import { statusMatches } from '../verdict.ts';
import { listOpenPulls } from '../github/pulls.ts';
import type { Runtime } from '../runtime.ts';
import type { ReportBaseline, ReportResult } from '../types.ts';

/** Read-only overview of every baseline and the open PRs it binds. */
export async function runReport(runtime: Runtime): Promise<ReportResult> {
	const { config, api, logger } = runtime;
	if (config.offline) {
		throw new ConfigError('report needs the API; --offline applies to refresh-pr-status only.');
	}
	const ancestry = await runtime.ancestry();
	const base = await runtime.base();
	const baselines = await runtime.readBaselines();
	const head = await runtime.head();
	const pulls = (await listOpenPulls(api, config.repo, { base, context: config.context })).filter(
		(pull) => pull.baseRef === base && (config.includeDrafts || !pull.isDraft),
	);
	const prepared = await ancestry.prepare?.({
		shas: [head],
		pulls: pulls.map((pull) => pull.number),
		refs: refSnapshot(baselines),
	});

	const bound = new Map<string, number>(baselines.map((baseline) => [baseline.name, 0]));
	for (const pull of pulls) {
		// The head the adapter fetched is the one that can be judged; without one, every baseline is assumed to bind.
		const fetched = prepared?.heads.get(pull.number);
		if (fetched === null) {
			for (const baseline of baselines) {
				bound.set(baseline.name, (bound.get(baseline.name) ?? 0) + 1);
			}
			continue;
		}
		const applicable = await applicableBaselines({
			ancestry,
			baselines,
			sha: fetched ?? pull.headSha,
			baseHead: head,
			logger,
		});
		for (const baseline of applicable) {
			if (baseline.applicable) {
				bound.set(baseline.name, (bound.get(baseline.name) ?? 0) + 1);
			}
		}
	}

	const report: ReportBaseline[] = [];
	for (const baseline of baselines) {
		report.push({
			...baseline,
			onBase: baseline.sha === null ? null : await ancestry.isAncestor(baseline.sha, head),
			bound: bound.get(baseline.name) ?? 0,
		});
	}
	const offBase = report.filter((baseline) => baseline.onBase === false).map((b) => b.name);
	if (offBase.length > 0) {
		logger.warn(
			`Baseline ${offBase.join(', ')} is not on ${base}; refreshes refuse to run until it is fixed.`,
		);
	}
	const result: ReportResult = {
		base,
		head,
		baselines: report,
		offBase,
		openPulls: pulls.length,
		ancestry: ancestry.name,
	};
	// Only the git adapter can afford a verdict per PR without spending API quota.
	if (ancestry.name === 'git' && offBase.length === 0) {
		Object.assign(
			result,
			await staleness(runtime, ancestry, baselines, head, pulls, base, prepared?.heads),
		);
	}
	return result;
}

/** Counts PRs whose status is current versus stale; skipped with a warning when the creator cannot be resolved. */
async function staleness(
	runtime: Runtime,
	ancestry: Ancestry,
	baselines: ResolvedBaseline[],
	head: string,
	pulls: OpenPull[],
	base: string,
	heads: Map<number, string | null> | undefined,
): Promise<{ stale?: number; current?: number }> {
	let creator: string;
	try {
		creator = await runtime.creator();
	} catch (error) {
		if (error instanceof ConfigError) {
			runtime.logger.warn(`${error.message} Stale counts are skipped.`);
			return {};
		}
		throw error;
	}
	const { config, logger } = runtime;
	const context = {
		base,
		descriptions: config.descriptions,
		targetUrl: config.targetUrl,
		repoUrl: repoUrl(config),
	};
	let stale = 0;
	let current = 0;
	for (const pull of pulls) {
		// A head that moved or vanished since the listing cannot be judged current; it is counted stale.
		const fetched = heads?.get(pull.number);
		if (fetched !== undefined && fetched !== pull.headSha) {
			stale++;
			continue;
		}
		const verdict = await evaluateCommit({
			ancestry,
			baselines,
			sha: pull.headSha,
			baseHead: head,
			context,
			logger,
		});
		if (statusMatches(pull.status, verdict.status, creator)) {
			current++;
		} else {
			stale++;
		}
	}
	return { stale, current };
}
