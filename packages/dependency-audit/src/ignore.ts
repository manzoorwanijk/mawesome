import type { Finding, FindingKind, IgnoreRule, Surface } from './types.ts';

const SURFACES = new Set<string>(['types', 'runtime']);
const KINDS = new Set<string>(['undeclared', 'missing-types', 'unresolved']);

/** `true` if the rule specifies at least one field (an empty rule must match nothing). */
function isSpecific(rule: IgnoreRule): boolean {
	return (
		rule.package !== undefined ||
		rule.specifier !== undefined ||
		rule.surface !== undefined ||
		rule.kind !== undefined
	);
}

/**
 * Validates untrusted ignore rules (e.g. from a JSON config) into `IgnoreRule[]`,
 * throwing a clear error rather than silently dropping a malformed rule (which would
 * mask a typo). Each rule must be an object that sets at least one known, well-typed field.
 */
export function parseIgnoreRules(value: unknown): IgnoreRule[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new Error('"ignore" must be an array of rules.');
	}
	return value.map(parseRule);
}

function parseRule(entry: unknown, index: number): IgnoreRule {
	if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
		throw new Error(`ignore[${index}] must be an object.`);
	}
	const raw = entry as Record<string, unknown>;
	const rule: IgnoreRule = {};
	if (raw['package'] !== undefined) {
		rule.package = asString(raw['package'], index, 'package');
	}
	if (raw['specifier'] !== undefined) {
		rule.specifier = asString(raw['specifier'], index, 'specifier');
	}
	if (raw['surface'] !== undefined) {
		rule.surface = asMember(raw['surface'], SURFACES, index, 'surface') as Surface;
	}
	if (raw['kind'] !== undefined) {
		rule.kind = asMember(raw['kind'], KINDS, index, 'kind') as FindingKind;
	}
	if (!isSpecific(rule)) {
		throw new Error(
			`ignore[${index}] must set at least one of: package, specifier, surface, kind.`,
		);
	}
	return rule;
}

function asString(value: unknown, index: number, field: string): string {
	if (typeof value !== 'string') {
		throw new Error(`ignore[${index}].${field} must be a string.`);
	}
	return value;
}

function asMember(value: unknown, allowed: Set<string>, index: number, field: string): string {
	if (typeof value !== 'string' || !allowed.has(value)) {
		throw new Error(`ignore[${index}].${field} must be one of: ${[...allowed].join(', ')}.`);
	}
	return value;
}

/** `true` if `finding` matches `rule` — every specified field must equal the finding's. */
export function matchesRule(finding: Finding, rule: IgnoreRule): boolean {
	if (!isSpecific(rule)) {
		return false;
	}
	return (
		(rule.package === undefined || rule.package === finding.packageName) &&
		(rule.specifier === undefined || rule.specifier === finding.specifier) &&
		(rule.surface === undefined || rule.surface === finding.surface) &&
		(rule.kind === undefined || rule.kind === finding.kind)
	);
}

/** Splits findings into the visible ones and those suppressed by an ignore rule. */
export function partitionIgnored(
	findings: Finding[],
	rules: IgnoreRule[],
): { findings: Finding[]; ignored: Finding[] } {
	const visible: Finding[] = [];
	const ignored: Finding[] = [];
	for (const finding of findings) {
		if (rules.some((rule) => matchesRule(finding, rule))) {
			ignored.push(finding);
		} else {
			visible.push(finding);
		}
	}
	return { findings: visible, ignored };
}
