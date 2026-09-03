import { repoParts, type ApiClient } from './api.ts';
import { GitHubError, isGitHubError } from './errors.ts';

/** Reads the commit a tag points at, peeling annotated tags; null when the tag does not exist. */
export async function readTag(api: ApiClient, repo: string, tag: string): Promise<string | null> {
	const parts = repoParts(repo);
	let object: { type: string; sha: string };
	try {
		const ref = await api.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
			...parts,
			ref: `tags/${tag}`,
		});
		object = ref.data.object;
	} catch (error) {
		if (isGitHubError(error, 'not-found')) {
			return null;
		}
		throw error;
	}
	// A tag may point at another tag; peel until a commit, remembering each object so a cycle cannot hang the run.
	const seen = new Set<string>();
	while (object.type === 'tag') {
		if (seen.has(object.sha)) {
			throw new GitHubError(
				'other',
				`GET /repos/${repo}/git/tags/${object.sha}`,
				`Tag ${tag} points at a cycle of tag objects.`,
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
			`GET /repos/${repo}/git/ref/tags/${tag}`,
			`Tag ${tag} points at a ${object.type}, not a commit.`,
		);
	}
	return object.sha;
}

/** Creates a lightweight tag; a 422 means the ref already exists. */
export async function createTag(
	api: ApiClient,
	repo: string,
	tag: string,
	sha: string,
): Promise<void> {
	await api.request('POST /repos/{owner}/{repo}/git/refs', {
		...repoParts(repo),
		ref: `refs/tags/${tag}`,
		sha,
	});
}

/** Moves a tag with `force: false`, so the server rejects anything but a fast-forward. */
export async function fastForwardTag(
	api: ApiClient,
	repo: string,
	tag: string,
	sha: string,
): Promise<void> {
	await api.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', {
		...repoParts(repo),
		ref: `tags/${tag}`,
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
