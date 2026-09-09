import { selectAncestry, type Selection } from './ancestry.ts';
import { ConfigError, resolveConfig, type ResolvedConfig } from './config.ts';
import { resolveCreator } from './creator.ts';
import { createApiClient, type ApiClient } from './github/api.ts';
import { revParse, type GitRepo } from './git/repo.ts';
import { getDefaultBranch, readBaselineRef, resolveCommit } from './github/refs.ts';
import { baselineRef } from './refname.ts';
import { createDryRunReporter, createStatusReporter } from './reporter/index.ts';
import type { Ancestry, ClientOptions, Logger, Reporter, ResolvedBaseline } from './types.ts';
import { defaultSleep } from './util.ts';

/** Everything a command needs; the lazy members are resolved once and only by commands that use them. */
export interface Runtime {
	config: ResolvedConfig;
	api: ApiClient;
	/** The selected adapter; resolved once, since choosing git means opening the clone. */
	ancestry(): Promise<Ancestry>;
	/** The local repository behind the git adapter; null with the API adapter. */
	repo(): Promise<GitRepo | null>;
	logger: Logger;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	/** The base branch name. */
	base(): Promise<string>;
	/** The base branch's current head; never cached, since a move can happen mid-run. */
	head(): Promise<string>;
	creator(): Promise<string>;
	reporter(): Promise<Reporter>;
	/** Whether a caller injected its own reporter, whose `current()` is then the only source of truth. */
	readonly customReporter: boolean;
	/** Reads every configured baseline ref, through the API or offline from the clone; absent refs resolve to a null SHA. */
	readBaselines(): Promise<ResolvedBaseline[]>;
}

export function createRuntime(options: ClientOptions): Runtime {
	const config = resolveConfig(options);
	// Every online run reads the baseline refs and the base head through the API, whichever adapter answers ancestry.
	if (!config.offline && config.token === undefined) {
		throw new ConfigError(
			'A token is required except for an offline refresh-pr-status: pass --token or set GITHUB_TOKEN.',
		);
	}
	const logger = options.logger ?? {
		info: (message) => console.error(message),
		warn: (message) => console.error(`Warning: ${message}`),
	};
	const sleep = options.sleep ?? defaultSleep;
	const api = createApiClient({
		apiUrl: config.apiUrl,
		graphqlUrl: config.graphqlUrl,
		token: config.token,
		fetch: options.fetch ?? globalThis.fetch,
		retryBaseMs: config.retryBaseMs,
		logger,
	});
	let selection: Promise<Selection> | undefined;
	const select = (): Promise<Selection> => {
		selection ??=
			options.ancestryAdapter === undefined
				? selectAncestry(config, api, logger)
				: Promise.resolve({ ancestry: options.ancestryAdapter, repo: null });
		return selection;
	};
	let base: Promise<string> | undefined;
	let creator: Promise<string> | undefined;
	let reporter: Promise<Reporter> | undefined;
	const runtime: Runtime = {
		config,
		api,
		ancestry: () => select().then((chosen) => chosen.ancestry),
		repo: () => select().then((chosen) => chosen.repo),
		logger,
		sleep,
		now: options.now ?? Date.now,
		customReporter: options.reporter !== undefined,
		base() {
			base ??= config.base === undefined ? defaultBranch() : Promise.resolve(config.base);
			return base;
		},
		async head() {
			const branch = await runtime.base();
			if (!config.offline) {
				return resolveCommit(api, config.repo, branch);
			}
			const repo = await runtime.repo();
			// Only the remote-tracking ref counts; a local branch of the same name is nobody's base.
			const sha =
				repo === null ? null : await revParse(repo, `refs/remotes/${repo.remote}/${branch}`);
			if (sha === null) {
				throw new ConfigError(
					`Offline: the clone has no refs/remotes/${repo?.remote ?? 'origin'}/${branch} to use as the base head.`,
				);
			}
			return sha;
		},
		creator() {
			creator ??= resolveCreator(config, api);
			return creator;
		},
		reporter() {
			reporter ??= (async () => {
				const inner =
					options.reporter ??
					createStatusReporter(api, {
						repo: config.repo,
						context: config.context,
						creator: await runtime.creator(),
						logger,
					});
				return config.dryRun ? createDryRunReporter(inner, logger) : inner;
			})();
			return reporter;
		},
		async readBaselines() {
			const resolved: ResolvedBaseline[] = [];
			const repo = config.offline ? await runtime.repo() : null;
			for (const baseline of config.baselines) {
				const sha =
					repo === null
						? await readBaselineRef(api, config.repo, baseline.name)
						: await revParse(repo, baselineRef(baseline.name));
				resolved.push({ ...baseline, sha });
			}
			return resolved;
		},
	};

	/** Offline, the clone's remote HEAD names the default branch; otherwise the API does. */
	async function defaultBranch(): Promise<string> {
		if (!config.offline) {
			return getDefaultBranch(api, config.repo);
		}
		const repo = await runtime.repo();
		const head =
			repo === null
				? ''
				: (
						await repo
							.git(['symbolic-ref', '--quiet', `refs/remotes/${repo.remote}/HEAD`])
							.catch(() => '')
					).trim();
		const prefix = `refs/remotes/${repo?.remote ?? 'origin'}/`;
		const branch = head.startsWith(prefix) ? head.slice(prefix.length) : '';
		if (branch.length === 0) {
			throw new ConfigError('Offline: pass --base, the clone does not record the default branch.');
		}
		return branch;
	}
	return runtime;
}
