import type { DescriptionTemplates, StatusPayload, StatusRecord, Verdict } from './types.ts';

/** GitHub rejects longer status descriptions with a validation error. */
export const MAX_DESCRIPTION_LENGTH = 140;
const LISTED_TAGS = 2;
const ELLIPSIS = '…';

export interface VerdictBaseline {
	tag: string;
	sha: string | null;
	/** Whether the baseline binds the commit; an unscoped baseline always does. */
	applicable: boolean;
	/** Whether the commit contains the baseline; null for an absent tag, which counts as satisfied. */
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
		.map((entry) => entry.tag);
	const tags = applicable.map((entry) => entry.tag);
	if (missing.length === 0) {
		return {
			kind: 'pass',
			status: payload('success', context.descriptions.pass, context, tags),
			missing,
			applicable: tags,
		};
	}
	return {
		kind: 'fail',
		status: payload('failure', context.descriptions.fail, context, missing),
		missing,
		applicable: tags,
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
export function misconfiguredVerdict(tags: string[], context: VerdictContext): Verdict {
	return {
		kind: 'misconfigured',
		status: payload(
			'success',
			'Baseline misconfigured: {tags} not on {base}; ask a maintainer.',
			context,
			tags,
		),
		missing: [],
		applicable: tags,
	};
}

/** Fills `{base}` and `{tags}` and bounds the result so a long template can never cause an API error. */
export function renderDescription(
	template: string,
	values: { base: string; tags: readonly string[] },
): string {
	const listed = values.tags.slice(0, LISTED_TAGS).join(', ');
	const rest = values.tags.length - LISTED_TAGS;
	const tags = rest > 0 ? `${listed} and ${rest} more` : listed;
	return boundDescription(template.replaceAll('{base}', values.base).replaceAll('{tags}', tags));
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
	tags: readonly string[],
): StatusPayload {
	return {
		state,
		description: renderDescription(template, { base: context.base, tags }),
		targetUrl: context.targetUrl,
	};
}
