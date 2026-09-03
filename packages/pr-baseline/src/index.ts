/**
 * @mawesome/pr-baseline: keep open pull requests current with a movable baseline on the base branch.
 *
 * `createClient` returns the four commands the CLI and the action call; the ports let a custom
 * integration swap the ancestry source, the reporter or `fetch`.
 */
export { createClient, type Client } from './client.ts';
export {
	ConfigError,
	DEFAULT_CONTEXT,
	DEFAULT_DESCRIPTIONS,
	DEFAULT_LABEL,
	DEFAULT_MAX_WRITES_PER_MINUTE,
	DEFAULT_MAX_WRITES_PER_RUN,
	DEFAULT_TAG,
	graphqlUrlFor,
	serverUrlFor,
	parseBaselines,
	shorthandBaselines,
	validateBaselines,
	type ResolvedConfig,
} from './config.ts';
export { GitHubError, isGitHubError, type FailureKind } from './github/errors.ts';
export { createMatcher, type PathMatcher } from './paths.ts';
export { createDryRunReporter, type DryRunReporter } from './reporter/index.ts';
export type {
	Ancestry,
	AncestryMode,
	Baseline,
	RefreshPrStatusOptions,
	RefreshPrStatusResult,
	ClientOptions,
	DescriptionTemplates,
	Logger,
	MoveBaselineOptions,
	MoveBaselineResult,
	MoveEntry,
	MoveReason,
	OtherBases,
	PrepareInput,
	PrepareResult,
	Reporter,
	ReportBaseline,
	ReportResult,
	ResolvedBaseline,
	StatusPayload,
	StatusRecord,
	StatusState,
	RefreshEntry,
	RefreshOutcome,
	RefreshPrStatusesResult,
	RefreshStopReason,
	Verdict,
	VerdictKind,
} from './types.ts';
export { BaselineError } from './util.ts';
export {
	boundDescription,
	computeVerdict,
	MAX_DESCRIPTION_LENGTH,
	renderDescription,
	statusMatches,
	type VerdictBaseline,
	type VerdictContext,
} from './verdict.ts';
