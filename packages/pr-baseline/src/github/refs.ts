import { repoParts, type ApiClient } from './api.ts';
import { GitHubError, isGitHubError } from './errors.ts';
import { baselineRef, baselineRefPath } from '../refname.ts';

/** Reads the commit a baseline ref points at, peeling tag objects; null when the ref does not exist. */
export async function readBaselineRef(
	api: ApiClient,
	repo: string,
	name: string,
): Promise<string | null> {
	const parts = repoParts(repo);
	let object: { type: string; sha: string };
	try {
		const ref = await api.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
			...parts,
			ref: baselineRefPath(name),
		});
		object = ref.data.object;
	} catch (error) {
		if (isGitHubError(error, 'not-found')) {
			return null;
		}
		throw error;
	}
	// A ref may point at a tag object; peel until a commit, remembering each object so a cycle cannot hang the run.
	const seen = new Set<string>();
	while (object.type === 'tag') {
		if (seen.has(object.sha)) {
			throw new GitHubError(
				'other',
				`GET /repos/${repo}/git/tags/${object.sha}`,
				`Baseline ${name} points at a cycle of tag objects.`,
			);
		}
		seen.add(object.sha);
		const nested = await api.request('GET /repos/{owner}/{repo}/git/tags/{tag_sha}', {
			...parts,
			tag_sha: object.sha,
		});
		object = nested.data.object;
	}
	if (object.type !== 'commit') {
		throw new GitHubError(
			'other',
			`GET /repos/${repo}/git/ref/${baselineRefPath(name)}`,
			`Baseline ${name} points at a ${object.type}, not a commit.`,
		);
	}
	return object.sha;
}

/** Creates the baseline ref; a 422 means it already exists. */
export async function createBaselineRef(
	api: ApiClient,
	repo: string,
	name: string,
	sha: string,
): Promise<void> {
	await api.request('POST /repos/{owner}/{repo}/git/refs', {
		...repoParts(repo),
		ref: baselineRef(name),
		sha,
	});
}

/**
 * Moves the baseline ref with `force: false`.
 * GitHub enforces a fast-forward only for branches, so the caller must check ancestry first and re-read afterwards.
 */
export async function updateBaselineRef(
	api: ApiClient,
	repo: string,
	name: string,
	sha: string,
): Promise<void> {
	await api.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', {
		...repoParts(repo),
		ref: baselineRefPath(name),
		sha,
		force: false,
	});
}

export async function getDefaultBranch(api: ApiClient, repo: string): Promise<string> {
	const repository = await api.request('GET /repos/{owner}/{repo}', repoParts(repo));
	return repository.data.default_branch;
}

/** Resolves a branch name, tag or SHA prefix to a full commit SHA. */
export async function resolveCommit(api: ApiClient, repo: string, ref: string): Promise<string> {
	const commit = await api.request('GET /repos/{owner}/{repo}/commits/{ref}', {
		...repoParts(repo),
		ref,
	});
	return commit.data.sha;
}
