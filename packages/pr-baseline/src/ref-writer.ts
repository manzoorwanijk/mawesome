import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type ApiClient } from './github/api.ts';
import { isGitHubError } from './github/errors.ts';
import { createBaselineRef, readBaselineRef, updateBaselineRef } from './github/refs.ts';
import { fetchMissingCommits, GitError, lsRemote, openRepo, type GitRepo } from './git/repo.ts';
import { baselineRef } from './refname.ts';
import type { Logger } from './types.ts';

const run = promisify(execFile);

/** How a ref was written: a lease push through git, or the refs API. */
export type WriteVia = 'git' | 'api';

/** A write that found the ref elsewhere than expected reports `actual`, the authoritative commit or null when absent. */
export type WriteOutcome = { ok: true; via: WriteVia } | { ok: false; actual: string | null };

/** Moves a baseline ref from the commit the run read to a target, or reports where the ref really is. */
export interface RefWriter {
	move(baseline: string, expected: string | null, to: string): Promise<WriteOutcome>;
	/** Releases whatever the writer set up; called once after the last move. */
	close?(): Promise<void>;
}

export interface RefWriterOptions {
	api: ApiClient;
	/** `owner/name`. */
	repo: string;
	/** The git server the token may be sent to; the ephemeral repository fetches and pushes there. */
	serverUrl: string;
	token: string | undefined;
	logger: Logger;
	/** False keeps every write on the refs API, as `--ancestry api` asks; git is then never run. */
	allowGit: boolean;
}

/**
 * The writer for a run: a lease push from the clone when there is one, else from an ephemeral repository when git
 * exists, else the refs API, which cannot refuse a concurrent move.
 */
export async function selectRefWriter(
	clone: GitRepo | null,
	options: RefWriterOptions,
): Promise<RefWriter> {
	const api = createApiRefWriter(options.api, options.repo);
	if (!options.allowGit) {
		return api;
	}
	const ephemeral = await createEphemeralRepo(options);
	if (ephemeral === null) {
		options.logger.warn(
			'Git is not available, so the move goes through the refs API, which cannot refuse a concurrent move.',
		);
	}
	const last =
		ephemeral === null
			? api
			: withFallback(createLeaseRefWriter(ephemeral.repo, options), api, options, ephemeral.close);
	return clone === null ? last : withFallback(createLeaseRefWriter(clone, options), last, options);
}

/**
 * Moves through the refs API, which enforces a fast-forward for branches only, so every write is re-read.
 * A crossing write that lands just before ours stays invisible, which is why the lease writers come first.
 */
export function createApiRefWriter(api: ApiClient, repo: string): RefWriter {
	return {
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
			return actual === to ? { ok: true, via: 'api' } : { ok: false, actual };
		},
	};
}

/**
 * Moves with `git push --force-with-lease`, a compare-and-swap the server enforces for every ref.
 * The lease names the advertised object, so a baseline parked on a tag object moves as well; git trouble throws.
 */
export function createLeaseRefWriter(
	git: GitRepo,
	options: Pick<RefWriterOptions, 'api' | 'repo'>,
): RefWriter {
	return {
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
					'--no-signed',
					`--force-with-lease=${ref}:${raw ?? ''}`,
					'--',
					git.url ?? git.remote,
					`${to}:${ref}`,
				]);
			} catch (error) {
				if (!(error instanceof GitError)) {
					throw error;
				}
				// Whatever git said, the API tells a lost lease from a real failure.
				const actual = await readBaselineRef(options.api, options.repo, baseline);
				if (actual !== expected) {
					return { ok: false, actual };
				}
				throw error;
			}
			return { ok: true, via: 'git' };
		},
	};
}

/** Hands a move to `next` when `primary` fails on a git error, with the reason in the log. */
function withFallback(
	primary: RefWriter,
	next: RefWriter,
	options: Pick<RefWriterOptions, 'logger'>,
	close?: () => Promise<void>,
): RefWriter {
	return {
		async move(baseline, expected, to) {
			try {
				return await primary.move(baseline, expected, to);
			} catch (error) {
				if (!(error instanceof GitError)) {
					throw error;
				}
				options.logger.warn(
					`Git could not move ${baselineRef(baseline)} (${firstLine(error.stderr) || error.message}); trying the next way.`,
				);
				return next.move(baseline, expected, to);
			}
		},
		async close() {
			await close?.();
			await next.close?.();
		},
	};
}

/**
 * An empty repository in a temporary directory, with the server's copy of the repository as its only remote.
 * It exists so a run without a usable clone can still lease-push; null when git cannot set it up.
 */
async function createEphemeralRepo(
	options: RefWriterOptions,
): Promise<{ repo: GitRepo; close: () => Promise<void> } | null> {
	let dir: string;
	try {
		dir = await mkdtemp(join(tmpdir(), 'pr-baseline-'));
	} catch {
		return null;
	}
	const close = () => rm(dir, { recursive: true, force: true });
	try {
		const url = `${options.serverUrl.replace(/\/+$/, '')}/${options.repo}`;
		await run('git', ['init', '--quiet', dir]);
		await run('git', ['-C', dir, 'remote', 'add', 'origin', url]);
		const repo = await openRepo(dir, {
			serverUrl: options.serverUrl,
			...(options.token === undefined ? {} : { token: options.token }),
		});
		if (repo === null) {
			await close();
			return null;
		}
		return { repo, close };
	} catch (error) {
		options.logger.warn(
			`No temporary git repository for the move (${error instanceof Error ? error.message : String(error)}).`,
		);
		await close();
		return null;
	}
}

function firstLine(text: string): string {
	return (
		text
			.split('\n')
			.find((line) => line.trim().length > 0)
			?.trim() ?? ''
	);
}
