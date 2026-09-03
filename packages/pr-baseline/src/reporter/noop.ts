import type { Logger, Reporter, StatusPayload } from '../types.ts';

export interface DryRunReporter extends Reporter {
	/** Every write the run would have made. */
	readonly intended: Array<{ sha: string; status: StatusPayload }>;
}

/** Reads through the real reporter and logs writes instead of making them. */
export function createDryRunReporter(inner: Reporter, logger: Logger): DryRunReporter {
	const intended: Array<{ sha: string; status: StatusPayload }> = [];
	return {
		intended,
		current(sha) {
			return inner.current(sha);
		},
		write(sha, status) {
			intended.push({ sha, status });
			logger.info(`[dry-run] ${sha.slice(0, 12)}: ${status.state} (${status.description})`);
			return Promise.resolve();
		},
	};
}
