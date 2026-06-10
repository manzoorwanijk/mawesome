import { sep } from 'node:path';
import type { Finding, FindingKind, IgnoreRule, Surface } from './types.ts';

const SURFACES = new Set<string>(['types', 'runtime']);
const KINDS = new Set<string>(['undeclared', 'missing-types', 'types-unavailable', 'unresolved']);

/** Free-text string fields, validated alike; `surface`/`kind` are enum-checked separately. */
const STRING_FIELDS = ['package', 'specifier', 'target', 'path'] as const;
/** Every matchable field, in the order shown to the user when a rule sets none. */
const RULE_FIELDS: readonly (keyof IgnoreRule)[] = [
	'package',
	'specifier',
	'surface',
	'kind',
	'target',
	'path',
];

/**
 * Identifies the audited target a finding belongs to, so `target`/`path`-scoped rules can
 * match. `name` is the manifest name (absent for an unnamed package); `target` is the spec
 * exactly as passed in (directory, `.tgz`, or registry spec).
 */
export interface IgnoreContext {
	name: string | undefined;
	target: string;
}

/** `true` if the rule specifies at least one field (an empty rule must match nothing). */
function isSpecific(rule: IgnoreRule): boolean {
	return RULE_FIELDS.some((field) => rule[field] !== undefined);
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
	for (const field of STRING_FIELDS) {
		if (raw[field] !== undefined) {
			rule[field] = asString(raw[field], index, field);
		}
	}
	if (raw['surface'] !== undefined) {
		rule.surface = asMember(raw['surface'], SURFACES, index, 'surface') as Surface;
	}
	if (raw['kind'] !== undefined) {
		rule.kind = asMember(raw['kind'], KINDS, index, 'kind') as FindingKind;
	}
	if (!isSpecific(rule)) {
		throw new Error(`ignore[${index}] must set at least one of: ${RULE_FIELDS.join(', ')}.`);
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

/**
 * `true` if `finding` matches `rule` — every specified field must equal the finding's.
 * A `target` rule needs the run {@link IgnoreContext} (it identifies the audited target),
 * so it never matches when no context is supplied. A `path` rule is finding-intrinsic
 * (it globs the finding's own `firstSeenIn`) and matches with or without a context.
 */
export function matchesRule(finding: Finding, rule: IgnoreRule, context?: IgnoreContext): boolean {
	if (!isSpecific(rule)) {
		return false;
	}
	return (
		(rule.package === undefined || rule.package === finding.packageName) &&
		(rule.specifier === undefined || rule.specifier === finding.specifier) &&
		(rule.surface === undefined || rule.surface === finding.surface) &&
		(rule.kind === undefined || rule.kind === finding.kind) &&
		(rule.target === undefined || matchesTarget(rule.target, context)) &&
		(rule.path === undefined || matchesPath(rule.path, finding.firstSeenIn))
	);
}

/** A `target` rule matches the audited package's name or the target spec exactly. */
function matchesTarget(target: string, context: IgnoreContext | undefined): boolean {
	return context !== undefined && (target === context.name || target === context.target);
}

/**
 * A `path` glob matches the finding's `firstSeenIn`. Both are normalized to `/` separators so
 * a glob written with the platform separator (e.g. `fixtures\**` on Windows) still matches a
 * `path.relative()`-derived `firstSeenIn`. Compiled globs are cached — a rule is reused across
 * every finding in a (potentially large) audit.
 */
function matchesPath(glob: string, firstSeenIn: string): boolean {
	return compileGlob(toPosix(glob)).test(toPosix(firstSeenIn));
}

const globCache = new Map<string, RegExp>();

function compileGlob(glob: string): RegExp {
	let compiled = globCache.get(glob);
	if (compiled === undefined) {
		compiled = globToRegExp(glob);
		globCache.set(glob, compiled);
	}
	return compiled;
}

function toPosix(path: string): string {
	return sep === '/' ? path : path.split(sep).join('/');
}

/*
 * Compiles a glob to a `/`-anchored RegExp over a POSIX path, following the common
 * gitignore/picomatch subset. A run of two or more stars is a globstar only as a whole path
 * segment: a leading or inner globstar segment matches zero or more path segments (so
 * "double-star then /x" matches both "x" and "a/b/x"), and a trailing globstar segment matches
 * all descendants (so "fixtures/" then double-star matches "fixtures/x" but not "fixtures").
 * A star run that is not a full segment (e.g. "a**b") degrades to a single-segment star.
 * A single star matches within one segment (never crosses `/`); `?` matches one non-`/`
 * character; every other character is matched literally (regex metacharacters escaped).
 * Consecutive stars are collapsed into one atom, so no input can emit adjacent `[^/]*`
 * quantifiers (which would expose the matcher to catastrophic backtracking / ReDoS).
 */
function globToRegExp(glob: string): RegExp {
	let out = '';
	let i = 0;
	while (i < glob.length) {
		const char = glob[i];
		if (char === '*') {
			const segmentStart = i === 0 || glob[i - 1] === '/';
			// Consume the whole run of `*` as one unit (collapsing `**`, `***`, … alike).
			let end = i + 1;
			while (glob[end] === '*') {
				end++;
			}
			const isGlobstar = end - i >= 2;
			const after = glob[end];
			if (isGlobstar && segmentStart && after === '/') {
				// A leading/inner globstar segment — match zero or more leading path segments.
				out += '(?:[^/]+/)*';
				i = end + 1;
			} else if (isGlobstar && segmentStart && after === undefined) {
				// A trailing (or lone) globstar segment — match all descendants.
				out += '.*';
				i = end;
			} else {
				// A single star, or a star run that is not a clean segment — one segment only.
				out += '[^/]*';
				i = end;
			}
			continue;
		}
		if (char === '?') {
			out += '[^/]';
			i += 1;
			continue;
		}
		// Escape every regex metacharacter so the rest is matched literally.
		out += (char ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		i += 1;
	}
	return new RegExp(`^${out}$`);
}

/**
 * Splits findings into the visible ones and those suppressed by an ignore rule.
 * When `used` is given, every rule that matched a suppressed finding is added to it (all matches, not just the first — overlapping rules each register), so a caller can detect stale rules across a run.
 */
export function partitionIgnored(
	findings: Finding[],
	rules: IgnoreRule[],
	context?: IgnoreContext,
	used?: Set<IgnoreRule>,
): { findings: Finding[]; ignored: Finding[] } {
	const visible: Finding[] = [];
	const ignored: Finding[] = [];
	for (const finding of findings) {
		let suppressed = false;
		for (const rule of rules) {
			if (matchesRule(finding, rule, context)) {
				suppressed = true;
				if (used === undefined) {
					// No tracker — the first match decides, as before.
					break;
				}
				used.add(rule);
			}
		}
		(suppressed ? ignored : visible).push(finding);
	}
	return { findings: visible, ignored };
}
