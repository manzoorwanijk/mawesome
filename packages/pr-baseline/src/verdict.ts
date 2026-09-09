import type { DescriptionTemplates, StatusPayload, StatusRecord, Verdict } from './types.ts';

/** GitHub rejects longer status descriptions with a validation error. */
export const MAX_DESCRIPTION_LENGTH = 140;
const LISTED_BASELINES = 2;
const ELLIPSIS = '…';

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
}

/** Combines per-baseline answers into the one status the context carries. */
export function computeVerdict(baselines: VerdictBaseline[], context: VerdictContext): Verdict {
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
		status: payload('failure', context.descriptions.fail, context, missing),
		missing,
		applicable: names,
	};
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

/** A status is current only when state, description, target URL and creator all match. */
export function statusMatches(
	current: StatusRecord | null,
	intended: StatusPayload,
	creator: string,
): boolean {
	if (current === null) {
		return false;
	}
	return (
		current.state === intended.state &&
		(current.description ?? '') === intended.description &&
		(current.targetUrl ?? '') === (intended.targetUrl ?? '') &&
		current.creator === creator
	);
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
