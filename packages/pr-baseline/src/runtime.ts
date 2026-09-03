import { selectAncestry } from './ancestry.ts';
import { resolveConfig, type ResolvedConfig } from './config.ts';
import { resolveCreator } from './creator.ts';
import { createApiClient, type ApiClient } from './github/api.ts';
import { getDefaultBranch, readTag, resolveCommit } from './github/refs.ts';
import { createDryRunReporter, createStatusReporter } from './reporter/index.ts';
import type { Ancestry, ClientOptions, Logger, Reporter, ResolvedBaseline } from './types.ts';
import { defaultSleep } from './util.ts';

/** Everything a command needs; the lazy members are resolved once and only by commands that use them. */
export interface Runtime {
	config: ResolvedConfig;
	api: ApiClient;
	ancestry: Ancestry;
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
	/** Reads every configured tag through the API; absent tags resolve to a null SHA. */
	readBaselines(): Promise<ResolvedBaseline[]>;
}

export function createRuntime(options: ClientOptions): Runtime {
	const config = resolveConfig(options);
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
	const ancestry = options.ancestryAdapter ?? selectAncestry(config, api, logger);
	let base: Promise<string> | undefined;
	let creator: Promise<string> | undefined;
	let reporter: Promise<Reporter> | undefined;
	const runtime: Runtime = {
		config,
		api,
		ancestry,
		logger,
		sleep,
		now: options.now ?? Date.now,
		customReporter: options.reporter !== undefined,
		base() {
			base ??=
				config.base === undefined
					? getDefaultBranch(api, config.repo)
					: Promise.resolve(config.base);
			return base;
		},
		async head() {
			return resolveCommit(api, config.repo, await runtime.base());
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
			for (const baseline of config.baselines) {
				resolved.push({ ...baseline, sha: await readTag(api, config.repo, baseline.tag) });
			}
			return resolved;
		},
	};
	return runtime;
}
