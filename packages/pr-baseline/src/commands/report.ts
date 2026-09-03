import { applicableBaselines } from '../evaluate.ts';
import { listOpenPulls } from '../github/pulls.ts';
import type { Runtime } from '../runtime.ts';
import type { ReportBaseline, ReportResult } from '../types.ts';

/** Read-only overview of every baseline and the open PRs it binds. */
export async function runReport(runtime: Runtime): Promise<ReportResult> {
	const { config, ancestry, api, logger } = runtime;
	const base = await runtime.base();
	const baselines = await runtime.readBaselines();
	const head = await runtime.head();
	const pulls = (await listOpenPulls(api, config.repo, { base, context: config.context })).filter(
		(pull) => pull.baseRef === base && (config.includeDrafts || !pull.isDraft),
	);

	const bound = new Map<string, number>(baselines.map((baseline) => [baseline.tag, 0]));
	for (const pull of pulls) {
		const applicable = await applicableBaselines({
			ancestry,
			baselines,
			sha: pull.headSha,
			baseHead: head,
			logger,
		});
		for (const baseline of applicable) {
			if (baseline.applicable) {
				bound.set(baseline.tag, (bound.get(baseline.tag) ?? 0) + 1);
			}
		}
	}

	const report: ReportBaseline[] = [];
	for (const baseline of baselines) {
		report.push({
			...baseline,
			onBase: baseline.sha === null ? null : await ancestry.isAncestor(baseline.sha, head),
			bound: bound.get(baseline.tag) ?? 0,
		});
	}
	const offBase = report.filter((baseline) => baseline.onBase === false).map((b) => b.tag);
	if (offBase.length > 0) {
		logger.warn(
			`Baseline ${offBase.join(', ')} is not on ${base}; sweeps refuse to run until it is fixed.`,
		);
	}
	return {
		base,
		head,
		baselines: report,
		offBase,
		openPulls: pulls.length,
		ancestry: ancestry.name,
	};
}
