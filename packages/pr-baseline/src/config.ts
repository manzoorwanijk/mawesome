import { isValidRefName } from './refname.ts';
import type {
	AncestryMode,
	Baseline,
	ClientOptions,
	DescriptionTemplates,
	OtherBases,
	RefreshScope,
} from './types.ts';

export const DEFAULT_NAME = 'pr-baseline';
export const DEFAULT_LABEL = 'Require PR update';
export const DEFAULT_CONTEXT = 'PR baseline';
export const DEFAULT_API_URL = 'https://api.github.com';
export const DEFAULT_MAX_WRITES_PER_RUN = 450;
export const DEFAULT_SCOPE: RefreshScope = 'corrections';
export const DEFAULT_MAX_WRITES_PER_MINUTE = 60;
export const DEFAULT_RETRY_BASE_MS = 1000;
export const DEFAULT_DESCRIPTIONS: DescriptionTemplates = {
	pass: 'Contains the required {base} changes.',
	fail: 'Merge or rebase {base} to include: {baselines}',
	notApplicable: 'Baseline applies to {base} only.',
};

const ANCESTRY_MODES = new Set<AncestryMode>(['auto', 'git', 'api']);
const OTHER_BASES = new Set<OtherBases>(['skip', 'pass']);
const SCOPES = new Set<RefreshScope>(['corrections', 'unstamped', 'all']);
const BASELINE_KEYS = new Set(['name', 'label', 'scope', 'markers']);

/** A configuration problem; reported before any evaluation and never retried. */
export class ConfigError extends Error {
	override name = 'ConfigError';
}

export interface ResolvedConfig {
	repo: string;
	token: string | undefined;
	apiUrl: string;
	graphqlUrl: string;
	serverUrl: string;
	base: string | undefined;
	baselines: Baseline[];
	context: string;
	descriptions: DescriptionTemplates;
	targetUrl: string | undefined;
	ancestry: AncestryMode;
	gitDir: string | undefined;
	otherBases: OtherBases;
	scope: RefreshScope;
	/** Whether the scope was asked for rather than defaulted; a custom reporter treats the two differently. */
	scopeExplicit: boolean;
	creator: string | undefined;
	tokenIsWorkflowToken: boolean;
	offline: boolean;
	maxWritesPerRun: number;
	maxWritesPerMinute: number;
	dryRun: boolean;
	includeDrafts: boolean;
	retryBaseMs: number;
}

/** Resolves options with flags over env over defaults; the base branch stays undefined until read from the repo. */
export function resolveConfig(options: ClientOptions): ResolvedConfig {
	const env = options.env ?? process.env;
	const repo = nonEmpty(options.repo) ?? nonEmpty(env['GITHUB_REPOSITORY']);
	if (!repo) {
		throw new ConfigError('A repository is required: pass --repo or set GITHUB_REPOSITORY.');
	}
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
		throw new ConfigError(`Invalid repository "${repo}": expected owner/name.`);
	}
	const apiUrl = (
		nonEmpty(options.apiUrl) ??
		nonEmpty(env['GITHUB_API_URL']) ??
		DEFAULT_API_URL
	).replace(/\/+$/, '');
	const ancestry = options.ancestry ?? 'auto';
	if (!ANCESTRY_MODES.has(ancestry)) {
		throw new ConfigError(`Invalid ancestry mode "${ancestry}": expected auto, git or api.`);
	}
	const otherBases = options.otherBases ?? 'skip';
	if (!OTHER_BASES.has(otherBases)) {
		throw new ConfigError(`Invalid other-bases value "${otherBases}": expected skip or pass.`);
	}
	const scope = options.scope;
	if (scope !== undefined && !SCOPES.has(scope)) {
		throw new ConfigError(`Invalid scope "${scope}": expected corrections, unstamped or all.`);
	}
	if ((options.offline ?? false) && ancestry === 'api') {
		throw new ConfigError('--offline needs git ancestry; drop --ancestry api.');
	}
	const baselines =
		options.baselines === undefined ? shorthandBaselines({}) : validateBaselines(options.baselines);
	const context = nonEmpty(options.context) ?? DEFAULT_CONTEXT;
	const creator = nonEmpty(options.creator);
	return {
		repo,
		token: nonEmpty(options.token) ?? nonEmpty(env['GITHUB_TOKEN']),
		apiUrl,
		serverUrl: (
			nonEmpty(options.serverUrl) ??
			nonEmpty(env['GITHUB_SERVER_URL']) ??
			serverUrlFor(apiUrl)
		).replace(/\/+$/, ''),
		graphqlUrl: (
			nonEmpty(options.graphqlUrl) ??
			nonEmpty(env['GITHUB_GRAPHQL_URL']) ??
			graphqlUrlFor(apiUrl)
		).replace(/\/+$/, ''),
		base: nonEmpty(options.base),
		baselines,
		context,
		descriptions: { ...DEFAULT_DESCRIPTIONS, ...compactTemplates(options.descriptions) },
		targetUrl: nonEmpty(options.targetUrl),
		ancestry,
		gitDir: nonEmpty(options.gitDir),
		otherBases,
		scope: scope ?? DEFAULT_SCOPE,
		scopeExplicit: scope !== undefined,
		creator,
		tokenIsWorkflowToken: options.tokenIsWorkflowToken ?? false,
		offline: options.offline ?? false,
		maxWritesPerRun: positiveInt(
			options.maxWritesPerRun,
			'maxWritesPerRun',
			DEFAULT_MAX_WRITES_PER_RUN,
		),
		maxWritesPerMinute: positiveInt(
			options.maxWritesPerMinute,
			'maxWritesPerMinute',
			DEFAULT_MAX_WRITES_PER_MINUTE,
		),
		dryRun: options.dryRun ?? false,
		includeDrafts: options.includeDrafts ?? true,
		retryBaseMs: nonNegativeInt(options.retryBaseMs, 'retryBaseMs', DEFAULT_RETRY_BASE_MS),
	};
}

/** Builds the one-entry list the `--name`, `--label` and `--markers` shorthand describes. */
export function shorthandBaselines(input: {
	name?: string | undefined;
	label?: string | undefined;
	markers?: string[] | undefined;
}): Baseline[] {
	const baseline: Baseline = {
		name: input.name ?? DEFAULT_NAME,
		label: input.label ?? DEFAULT_LABEL,
	};
	if (input.markers !== undefined) {
		baseline.markers = input.markers;
	}
	return validateBaselines([baseline]);
}

/** Parses the `--baselines` JSON value; `@path` reads the JSON from a file. */
export function parseBaselines(json: string, readFile: (path: string) => string): Baseline[] {
	const source = json.startsWith('@') ? readFile(json.slice(1)) : json;
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch (error) {
		throw new ConfigError(`Baselines are not valid JSON: ${(error as Error).message}`);
	}
	return validateBaselines(value);
}

/** Validates the baseline list against the full schema; every problem is fatal. */
export function validateBaselines(value: unknown): Baseline[] {
	if (!Array.isArray(value)) {
		throw new ConfigError('Baselines must be a JSON array of { name, label?, scope?, markers? }.');
	}
	if (value.length === 0) {
		throw new ConfigError('Baselines must contain at least one entry.');
	}
	const seen = new Set<string>();
	return value.map((entry: unknown, index): Baseline => {
		const where = `Baseline ${index + 1}`;
		if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
			throw new ConfigError(`${where} must be an object.`);
		}
		const record = entry as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			if (!BASELINE_KEYS.has(key)) {
				throw new ConfigError(`${where} has an unknown field "${key}".`);
			}
		}
		const name = record['name'];
		if (typeof name !== 'string' || !isValidRefName(name)) {
			throw new ConfigError(`${where} needs a valid name (git check-ref-format rules).`);
		}
		if (seen.has(name)) {
			throw new ConfigError(`Baseline "${name}" is listed more than once.`);
		}
		seen.add(name);
		const baseline: Baseline = { name };
		if (record['label'] !== undefined) {
			const label = record['label'];
			if (typeof label !== 'string' || label.trim().length === 0) {
				throw new ConfigError(`${where} has an empty label.`);
			}
			baseline.label = label.trim();
		}
		for (const field of ['scope', 'markers'] as const) {
			if (record[field] === undefined) {
				continue;
			}
			baseline[field] = validatePatterns(record[field], `${where} ${field}`);
		}
		return baseline;
	});
}

function validatePatterns(value: unknown, where: string): string[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new ConfigError(`${where} must be a non-empty array of patterns.`);
	}
	return value.map((pattern: unknown) => {
		if (typeof pattern !== 'string' || pattern.trim().length === 0) {
			throw new ConfigError(`${where} contains an empty pattern.`);
		}
		return pattern;
	});
}

function compactTemplates(
	templates: Partial<DescriptionTemplates> | undefined,
): Partial<DescriptionTemplates> {
	const result: Partial<DescriptionTemplates> = {};
	for (const key of ['pass', 'fail', 'notApplicable'] as const) {
		const value = nonEmpty(templates?.[key]);
		if (value !== undefined) {
			result[key] = value;
		}
	}
	return result;
}

/** The repository's web URL on the configured server, with a trailing slash on the server trimmed. */
export function repoUrl(config: Pick<ResolvedConfig, 'serverUrl' | 'repo'>): string {
	return `${config.serverUrl.replace(/\/+$/, '')}/${config.repo}`;
}

/** The git server behind a REST root: `api.github.com` is `github.com`, a GHES `/api/v3` root is its host. */
export function serverUrlFor(apiUrl: string): string {
	if (apiUrl === DEFAULT_API_URL) {
		return 'https://github.com';
	}
	try {
		return new URL(apiUrl).origin;
	} catch {
		return apiUrl.replace(/\/api\/v3$/, '');
	}
}

/** GitHub.com and GHES serve GraphQL beside the REST root, not under it: `/api/v3` pairs with `/api/graphql`. */
export function graphqlUrlFor(apiUrl: string): string {
	if (apiUrl === DEFAULT_API_URL) {
		return `${DEFAULT_API_URL}/graphql`;
	}
	return apiUrl.endsWith('/api/v3') ? `${apiUrl.slice(0, -3)}/graphql` : `${apiUrl}/graphql`;
}

function nonEmpty(value: string | undefined): string | undefined {
	return value !== undefined && value.length > 0 ? value : undefined;
}

function nonNegativeInt(value: number | undefined, name: string, fallback: number): number {
	if (value === undefined) {
		return fallback;
	}
	if (!Number.isInteger(value) || value < 0) {
		throw new ConfigError(`${name} must be a non-negative integer.`);
	}
	return value;
}

function positiveInt(value: number | undefined, name: string, fallback: number): number {
	if (value === undefined) {
		return fallback;
	}
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new ConfigError(`${name} must be a positive integer.`);
	}
	return value;
}
