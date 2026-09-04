import { ConfigError, type ResolvedConfig } from './config.ts';
import { createGitAncestry } from './git/ancestry.ts';
import {
	GitError,
	gitVersion,
	hasGrafts,
	promisorsAreValidated,
	isShallow,
	MIN_OFFLINE_GIT,
	openRepo,
	remoteServes,
	supportsNoLazyFetch,
	transportOf,
	type GitRepo,
} from './git/repo.ts';
import type { ApiClient } from './github/api.ts';
import { createApiAncestry } from './github/compare.ts';
import type { Ancestry, Logger } from './types.ts';

export interface Selection {
	ancestry: Ancestry;
	/** The local repository the git adapter uses; null for the API adapter. */
	repo: GitRepo | null;
}

/** Picks the ancestry adapter: git when a clone of the repository is at hand, otherwise the API. */
export async function selectAncestry(
	config: ResolvedConfig,
	api: ApiClient,
	logger: Logger,
): Promise<Selection> {
	if (config.ancestry !== 'api') {
		const repo = await openRepo(config.gitDir, {
			offline: config.offline,
			serverUrl: config.serverUrl,
			...(config.token === undefined ? {} : { token: config.token }),
		});
		// Scheme-agnostic first, so a clone of another repository is named as such before any transport talk.
		const servesPath =
			repo !== null && (await remoteServes(repo, config.repo, config.serverUrl, { offline: true }));
		const serves =
			servesPath &&
			repo !== null &&
			(config.offline || (await remoteServes(repo, config.repo, config.serverUrl)));
		// A shallow clone can hold both commits of a question and still answer it wrong, so it is never used.
		const shallow = repo !== null && serves && (await isShallow(repo));
		// Grafts rewrite ancestry locally and cannot be switched off like replacement objects.
		const grafted = repo !== null && serves && !shallow && (await hasGrafts(repo));
		// A lazy fetch contacts promisor remotes by itself; only the validated one may exist.
		const strayPromisor =
			repo !== null && serves && !shallow && !grafted && !(await promisorsAreValidated(repo));
		// Online, git may only talk https (the token's channel) or a local path; ssh runs programs, http is plaintext.
		const transport = repo?.url === null || repo === null ? null : transportOf(repo.url);
		const plainOnline =
			servesPath &&
			!config.offline &&
			transport !== null &&
			transport !== 'https' &&
			transport !== 'file';
		// Presence probes rely on `GIT_NO_LAZY_FETCH`; without it a partial clone fetches one commit at a time.
		const oldGit =
			repo !== null &&
			serves &&
			!shallow &&
			!grafted &&
			!strayPromisor &&
			!plainOnline &&
			!supportsNoLazyFetch(await gitVersion(repo));
		if (
			repo !== null &&
			serves &&
			!shallow &&
			!grafted &&
			!strayPromisor &&
			!plainOnline &&
			!oldGit
		) {
			logger.info(`Using git ancestry in ${repo.dir}.`);
			const git = createGitAncestry({ repo, logger, offline: config.offline });
			if (config.ancestry === 'git' || config.offline || !api.hasToken) {
				return { ancestry: git, repo };
			}
			// In `auto`, a clone that cannot fetch what a run needs hands over to the API instead of failing it.
			return {
				ancestry: withApiFallback(git, createApiAncestry(api, config.repo, logger), logger),
				repo,
			};
		}
		if (config.ancestry === 'git' || config.offline) {
			throw new ConfigError(
				repo === null
					? `No git repository at ${config.gitDir ?? process.cwd()}; git ancestry needs a clone of ${config.repo}.`
					: !servesPath
						? `The repository at ${repo.dir} does not have ${config.repo} as its "${repo.remote}" remote.`
						: shallow
							? `The clone at ${repo.dir} is shallow; git ancestry needs full history (actions/checkout with fetch-depth: 0 and filter: tree:0).`
							: grafted
								? `The clone at ${repo.dir} has an info/grafts file, which rewrites ancestry; remove it.`
								: strayPromisor
									? `The clone at ${repo.dir} has a promisor remote other than "${repo.remote}"; remove it.`
									: plainOnline
										? `The clone at ${repo.dir} fetches over ${transport}; online git ancestry needs an https remote (refresh-pr-status --offline still works).`
										: oldGit
											? `Git ancestry needs git ${MIN_OFFLINE_GIT} or newer, which can forbid a partial clone's lazy fetches.`
											: `The repository at ${repo.dir} does not have ${config.repo} as its "${repo.remote}" remote.`,
			);
		}
		// No repository at all is the ordinary API case; a repository that cannot be used deserves a warning.
		if (repo !== null) {
			logger.warn(
				!servesPath
					? `The repository at ${repo.dir} does not serve ${config.repo} from "${repo.remote}"; falling back to API ancestry.`
					: shallow
						? `The clone at ${repo.dir} is shallow; falling back to API ancestry.`
						: grafted
							? `The clone at ${repo.dir} has an info/grafts file; falling back to API ancestry.`
							: strayPromisor
								? `The clone at ${repo.dir} has a promisor remote other than "${repo.remote}"; falling back to API ancestry.`
								: plainOnline
									? `The clone at ${repo.dir} fetches over ${transport}; falling back to API ancestry.`
									: `Git is older than ${MIN_OFFLINE_GIT}; falling back to API ancestry.`,
			);
		} else if (config.gitDir !== undefined) {
			logger.warn(`No git repository at ${config.gitDir}; falling back to API ancestry.`);
		}
	}
	return { ancestry: createApiAncestry(api, config.repo, logger), repo: null };
}

/**
 * Delegates to git until a git command fails while preparing, then to the API for the rest of the run.
 * Integrity refusals (a tag disagreement, a configuration error) are not git failures and still end the run.
 */
function withApiFallback(git: Ancestry, api: Ancestry, logger: Logger): Ancestry {
	let active = git;
	return {
		get name() {
			return active.name;
		},
		isAncestor: (ancestor, descendant) => active.isAncestor(ancestor, descendant),
		changedFiles: (from, to) => active.changedFiles(from, to),
		async prepare(input) {
			if (active !== git || git.prepare === undefined) {
				return active.prepare?.(input) ?? { heads: new Map() };
			}
			try {
				return await git.prepare(input);
			} catch (error) {
				if (!(error instanceof GitError)) {
					throw error;
				}
				logger.warn(
					`Git could not prepare the clone (${error.message}); falling back to API ancestry.`,
				);
				active = api;
				return { heads: new Map() };
			}
		},
	};
}
