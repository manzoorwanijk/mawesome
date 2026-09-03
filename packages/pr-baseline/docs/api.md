# Programmatic API

The CLI and the action are thin consumers of this API, so everything they do is available to your own integration.

```ts
import { createClient } from '@mawesome/pr-baseline';

const client = createClient({
	repo: 'owner/name',
	token: process.env.GITHUB_TOKEN,
	baselines: [{ tag: 'pr-baseline', label: 'Require PR update', markers: ['.nvmrc'] }],
	creator: 'github-actions[bot]',
});

await client.check({ pr: 42 });
await client.sweep();
await client.moveBaseline({ force: true, sweep: true });
await client.report();
```

## `createClient(options)`

Resolves the configuration (flags over `env` over defaults) and throws `ConfigError` for anything invalid before a single request is made. The base branch and the status creator are resolved lazily by the commands that need them. `client.config` exposes the resolved configuration.

`ClientOptions` mirrors the [CLI options](./cli.md) in camelCase (`apiUrl`, `otherBases`, `maxWritesPerRun`, `descriptions.{pass,fail,notApplicable}`, ...) plus:

| Option                 | Purpose                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch`                | Injectable `fetch`, for tests and custom transports.                                                                                        |
| `ancestryAdapter`      | An `Ancestry` implementation replacing the built-in adapters.                                                                               |
| `reporter`             | A `Reporter` implementation replacing commit statuses.                                                                                      |
| `logger`               | `{ info, warn }`; defaults to stderr.                                                                                                       |
| `sleep`, `now`         | Injectable clock and sleep for write pacing.                                                                                                |
| `retryBaseMs`          | Base delay for retrying transient server errors (three attempts, quadratic backoff); default 1000.                                          |
| `env`                  | Environment to read fallbacks from; defaults to `process.env`.                                                                              |
| `tokenIsWorkflowToken` | Set by the action when `token` is provably the workflow's own token, which resolves the creator to `github-actions[bot]` without a request. |
| `includeDrafts`        | Whether draft PRs are swept; default `true`. Not exposed by the CLI.                                                                        |

## Commands

- `check(options?: CheckOptions): Promise<CheckResult>` with `sha`, `pr` and `report`.
- `sweep(): Promise<SweepResult>`.
- `moveBaseline(options?: MoveBaselineOptions): Promise<MoveBaselineResult>` with `force`, `to`, `baseline` and `sweep`.
- `report(): Promise<ReportResult>`.

Each result carries the base branch and the resolved baselines (`{ tag, sha }` with `sha: null` for an absent tag; after `moveBaseline`, the SHAs after the moves). `CheckResult.verdict` holds the verdict, `SweepResult.entries` lists every PR the sweep reached with its outcome (`written`, `skipped`, `closed`, `deferred`, `failed`; a sweep stopped by a budget or a rate limit lists only the PRs before the stop), `MoveBaselineResult.moves` says what moved and why, and `ReportResult.offBase` names baselines that left the base branch.

## Ports

```ts
interface Ancestry {
	readonly name: 'git' | 'api';
	isAncestor(ancestor: string, descendant: string): Promise<boolean>;
	/** Files changed on `to` since its merge base with `from`; null when indeterminate. */
	changedFiles(from: string, to: string): Promise<string[] | null>;
}

interface Reporter {
	current(sha: string): Promise<StatusRecord | null>;
	write(sha: string, status: StatusPayload): Promise<void>;
}
```

A custom reporter can post a comment, create a check run or forward to a hosted service. `check` and `sweep` compare `current()` against the intended status by state, description, target URL and creator, so a reporter that stores no creator should return the configured one. The built-in status reporter is the one exception: the sweep reads its current statuses from the PR listing, one GraphQL page per 100 PRs, instead of calling `current()` per PR.

## Errors

- `ConfigError`: invalid or missing configuration, including an unresolvable creator or a write that came back under another login. Exit code 2 in the CLI.
- `BaselineError`: a repository state the tool refuses to act on, such as a baseline that is not on the base branch or a target that does not descend from the current baseline. Exit code 2.
- `GitHubError`: a failed request, with `kind` in `rate-limit`, `auth`, `permission`, `not-found`, `conflict`, `status-cap`, `validation`, `server` (any 5xx after the retries), `network`, `other`, plus `status`, `path`, `body` and `retryAfterMs`. `isGitHubError(error, kind?)` narrows it.

## Pure helpers

`computeVerdict`, `renderDescription`, `boundDescription`, `statusMatches`, `validateBaselines`, `parseBaselines`, `shorthandBaselines` and `createMatcher` are exported for tests and for integrations that want the same decisions without the client.
