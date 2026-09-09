import { createMatcher } from './paths.ts';
import type { Ancestry, Logger, ResolvedBaseline, Verdict } from './types.ts';
import { computeVerdict, type VerdictBaseline, type VerdictContext } from './verdict.ts';
import { shortSha } from './util.ts';

export interface EvaluateInput {
	ancestry: Ancestry;
	baselines: ResolvedBaseline[];
	/** The commit under evaluation. */
	sha: string;
	/** Base branch head, the reference for scoped diffs. */
	baseHead: string;
	context: VerdictContext;
	logger: Logger;
}

/** Which baselines bind a commit: unscoped ones always, scoped ones when the commit's diff touches their scope. */
export async function applicableBaselines(
	input: Pick<EvaluateInput, 'ancestry' | 'baselines' | 'sha' | 'baseHead' | 'logger'>,
): Promise<Array<ResolvedBaseline & { applicable: boolean }>> {
	const scoped = input.baselines.some((baseline) => baseline.scope !== undefined);
	let files: string[] | null | undefined;
	if (scoped) {
		files = await input.ancestry.changedFiles(input.baseHead, input.sha);
		if (files === null) {
			input.logger.warn(
				`Changed files for ${shortSha(input.sha)} are indeterminate; every scoped baseline is treated as applicable.`,
			);
		}
	}
	return input.baselines.map((baseline) => {
		if (baseline.scope === undefined || files === null) {
			return { ...baseline, applicable: true };
		}
		return { ...baseline, applicable: createMatcher(baseline.scope).touches(files ?? []) };
	});
}

/** Evaluates one commit against every configured baseline and combines the answers into a verdict. */
export async function evaluateCommit(input: EvaluateInput): Promise<Verdict> {
	const applicable = await applicableBaselines(input);
	const answers: VerdictBaseline[] = [];
	for (const baseline of applicable) {
		let contains: boolean | null = null;
		if (baseline.applicable && baseline.sha !== null) {
			contains = await input.ancestry.isAncestor(baseline.sha, input.sha);
		}
		answers.push({
			name: baseline.name,
			sha: baseline.sha,
			applicable: baseline.applicable,
			contains,
		});
	}
	return computeVerdict(answers, input.context);
}

/** Baselines whose commit is not on the base branch; such a baseline can never be satisfied by merging. */
export async function baselinesOffBase(
	ancestry: Ancestry,
	baselines: ResolvedBaseline[],
	baseHead: string,
): Promise<string[]> {
	const off: string[] = [];
	for (const baseline of baselines) {
		if (baseline.sha !== null && !(await ancestry.isAncestor(baseline.sha, baseHead))) {
			off.push(baseline.name);
		}
	}
	return off;
}
