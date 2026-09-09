import { type ApiClient } from './github/api.ts';
import { isGitHubError } from './github/errors.ts';
import { createBaselineRef, readBaselineRef, updateBaselineRef } from './github/refs.ts';
import { fetchMissingCommits, GitError, lsRemote, type GitRepo } from './git/repo.ts';
import { baselineRef } from './refname.ts';
import type { Logger } from './types.ts';

/** A write that found the ref elsewhere than expected; `actual` is the authoritative commit, null when absent. */
export type WriteOutcome = { ok: true } | { ok: false; actual: string | null };

/** Moves a baseline ref from the commit the run read to a target, or reports where the ref really is. */
export interface RefWriter {
	readonly name: 'git' | 'api';
	move(baseline: string, expected: string | null, to: string): Promise<WriteOutcome>;
}

/**
 * Moves through the refs API, which enforces a fast-forward for branches only.
 * A crossing write is therefore visible only afterwards, so every write is followed by a re-read.
 */
export function createApiRefWriter(api: ApiClient, repo: string): RefWriter {
	return {
		name: 'api',
		async move(baseline, expected, to) {
			try {
				if (expected === null) {
					await createBaselineRef(api, repo, baseline, to);
				} else {
					await updateBaselineRef(api, repo, baseline, to);
				}
			} catch (error) {
				if (!isGitHubError(error, 'conflict') && !isGitHubError(error, 'validation')) {
					throw error;
				}
				// A rejected write with the ref unchanged means the request itself was invalid.
				const actual = await readBaselineRef(api, repo, baseline);
				if (actual === expected) {
					throw error;
				}
				return { ok: false, actual };
			}
			const actual = await readBaselineRef(api, repo, baseline);
			return actual === to ? { ok: true } : { ok: false, actual };
		},
	};
}

/**
 * Moves with `git push --force-with-lease`, a compare-and-swap the server enforces for every ref.
 * The lease names the ref's advertised object, so a baseline parked on a tag object moves as well.
 */
export function createLeaseRefWriter(
	git: GitRepo,
	api: ApiClient,
	repo: string,
	logger: Logger,
): RefWriter {
	const fallback = createApiRefWriter(api, repo);
	return {
		name: 'git',
		async move(baseline, expected, to) {
			const ref = baselineRef(baseline);
			const advertised = await lsRemote(git, [ref, `${ref}^{}`]);
			const raw = advertised.get(ref) ?? null;
			const peeled = advertised.get(`${ref}^{}`) ?? raw;
			if (peeled !== expected) {
				return { ok: false, actual: peeled };
			}
			await fetchMissingCommits(git, [to]);
			try {
				await git.git([
					'push',
					'--quiet',
					`--force-with-lease=${ref}:${raw ?? ''}`,
					'--',
					git.url ?? git.remote,
					`${to}:${ref}`,
				]);
				return { ok: true };
			} catch (error) {
				if (!(error instanceof GitError)) {
					throw error;
				}
				// Whatever git said, the API tells a lost lease from a real failure; the latter still has the API path.
				const actual = await readBaselineRef(api, repo, baseline);
				if (actual !== expected) {
					return { ok: false, actual };
				}
				logger.warn(
					`Pushing ${ref} failed (${firstLine(error.stderr)}); moving through the API instead.`,
				);
				return fallback.move(baseline, expected, to);
			}
		},
	};
}

function firstLine(text: string): string {
	return (
		text
			.split('\n')
			.find((line) => line.trim().length > 0)
			?.trim() ?? 'no output'
	);
}
