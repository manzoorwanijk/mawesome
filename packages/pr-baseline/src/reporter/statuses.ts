import { ConfigError } from '../config.ts';
import { repoParts, type ApiClient } from '../github/api.ts';
import { readCommitStatus } from '../github/pulls.ts';
import type { Logger, Reporter } from '../types.ts';

export interface StatusReporterOptions {
	repo: string;
	context: string;
	/** The login every write must come back as; a mismatch is a configuration error. */
	creator: string;
	logger: Logger;
}

/** Reports verdicts as commit statuses. */
export function createStatusReporter(api: ApiClient, options: StatusReporterOptions): Reporter {
	const { repo, context, creator } = options;
	return {
		current(sha) {
			return readCommitStatus(api, repo, { sha, context });
		},
		async write(sha, status) {
			const response = await api.request('POST /repos/{owner}/{repo}/statuses/{sha}', {
				...repoParts(repo),
				sha,
				state: status.state,
				context,
				description: status.description,
				target_url: status.targetUrl ?? null,
				// Retries of a write are the caller's decision, so they count against the write budget.
				request: { retries: 0 },
			});
			const actual = response.data.creator?.login ?? null;
			if (actual !== creator) {
				throw new ConfigError(
					`Status on ${sha.slice(0, 12)} was written as "${actual ?? 'unknown'}" but the run resolved the creator as "${creator}"; pass --creator with the login the token writes as.`,
				);
			}
		},
	};
}
