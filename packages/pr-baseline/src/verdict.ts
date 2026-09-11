import type { DescriptionTemplates, StatusPayload, StatusRecord, Verdict } from './types.ts';

/** GitHub rejects longer status descriptions with a validation error. */
export const MAX_DESCRIPTION_LENGTH = 140;
const LISTED_BASELINES = 2;
const ELLIPSIS = '…';

/** How an existing status differs from the intended one: not at all, in text only, or in a way that gates a merge. */
export type StatusDifference = 'current' | 'cosmetic' | 'material';

export interface VerdictBaseline {
	name: string;
	sha: string | null;
	/** Whether the baseline binds the commit; an unscoped baseline always does. */
	applicable: boolean;
	/** Whether the commit contains the baseline; null for an absent ref, which counts as satisfied. */
	contains: boolean | null;
}

export interface VerdictContext {
	base: string;
	descriptions: DescriptionTemplates;
	targetUrl: string | undefined;
	/** The repository's web URL; without a configured target URL a failing status links to its compare view. */
	repoUrl?: string;
}

/**
 * Combines per-baseline answers into the one status the context carries.
 * With `head`, a failing status without a configured link points at the commits the base branch has that the head lacks.
 */
export function computeVerdict(
	baselines: VerdictBaseline[],
	context: VerdictContext,
	head?: string,
): Verdict {
	const applicable = baselines.filter((entry) => entry.applicable);
	const missing = applicable
		.filter((entry) => entry.sha !== null && entry.contains === false)
		.map((entry) => entry.name);
	const names = applicable.map((entry) => entry.name);
	if (missing.length === 0) {
		return {
			kind: 'pass',
			status: payload('success', context.descriptions.pass, context, names),
			missing,
			applicable: names,
		};
	}
	return {
		kind: 'fail',
		status: {
			...payload('failure', context.descriptions.fail, context, missing),
			targetUrl: context.targetUrl ?? compareUrl(context, head, context.base),
		},
		missing,
		applicable: names,
	};
}

/**
 * GitHub's three-dot compare: the commits on the base branch that the head does not contain.
 * Naming the branch rather than the baseline commit keeps the link identical across a move, so a move alone never costs a write.
 */
export function compareUrl(
	context: Pick<VerdictContext, 'repoUrl'>,
	head: string | undefined,
	base: string,
): string | undefined {
	if (context.repoUrl === undefined || head === undefined) {
		return undefined;
	}
	return `${context.repoUrl}/compare/${head}...${encodeURIComponent(base)}`;
}

/** The pass written for a PR outside the base branch when `other-bases` is `pass`. */
export function notApplicableVerdict(context: VerdictContext): Verdict {
	return {
		kind: 'not-applicable',
		status: payload('success', context.descriptions.notApplicable, context, []),
		missing: [],
		applicable: [],
	};
}

/** A pass that names a baseline no longer on the base branch, so an operator mistake blocks nobody. */
export function misconfiguredVerdict(names: string[], context: VerdictContext): Verdict {
	return {
		kind: 'misconfigured',
		status: payload(
			'success',
			'Baseline misconfigured: {baselines} not on {base}; ask a maintainer.',
			context,
			names,
		),
		missing: [],
		applicable: names,
	};
}

/** Fills `{base}` and `{baselines}` and bounds the result so a long template can never cause an API error. */
export function renderDescription(
	template: string,
	values: { base: string; baselines: readonly string[] },
): string {
	const listed = values.baselines.slice(0, LISTED_BASELINES).join(', ');
	const rest = values.baselines.length - LISTED_BASELINES;
	const baselines = rest > 0 ? `${listed} and ${rest} more` : listed;
	return boundDescription(
		template.replaceAll('{base}', values.base).replaceAll('{baselines}', baselines),
	);
}

/** Truncates to the API limit by code points, ending with an ellipsis when cut. */
export function boundDescription(text: string): string {
	const points = Array.from(text);
	if (points.length <= MAX_DESCRIPTION_LENGTH) {
		return text;
	}
	return points.slice(0, MAX_DESCRIPTION_LENGTH - 1).join('') + ELLIPSIS;
}

/**
 * Whether an intended status differs from the one on the commit, and whether the difference gates a merge.
 * A creator mismatch is material because a ruleset pinned to a source is not satisfied by another creator's green.
 */
export function compareStatus(
	current: StatusRecord | null,
	intended: StatusPayload,
	creator: string,
): StatusDifference {
	if (current === null || current.state !== intended.state || current.creator !== creator) {
		return 'material';
	}
	const drifted =
		(current.description ?? '') !== intended.description ||
		(current.targetUrl ?? '') !== (intended.targetUrl ?? '');
	return drifted ? 'cosmetic' : 'current';
}

function payload(
	state: 'success' | 'failure',
	template: string,
	context: VerdictContext,
	baselines: readonly string[],
): StatusPayload {
	return {
		state,
		description: renderDescription(template, { base: context.base, baselines }),
		targetUrl: context.targetUrl,
	};
}
