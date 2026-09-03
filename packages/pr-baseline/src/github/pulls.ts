import type { StatusRecord, StatusState } from '../types.ts';
import { repoParts, type ApiClient } from './api.ts';
import { isGitHubError } from './errors.ts';

export interface OpenPull {
	number: number;
	headSha: string;
	isDraft: boolean;
	baseRef: string;
	/** The head repository's `owner/name`; null when it was deleted. */
	headRepo: string | null;
	status: StatusRecord | null;
}

export interface PullInfo {
	number: number;
	state: 'open' | 'closed';
	merged: boolean;
	headSha: string;
	baseRef: string;
}

interface StatusContextNode {
	state: string;
	description: string | null;
	targetUrl: string | null;
	creator: { login: string } | null;
}

interface OpenPullsData {
	repository: {
		pullRequests: {
			pageInfo: { hasNextPage: boolean; endCursor: string | null };
			nodes: Array<{
				number: number;
				isDraft: boolean;
				headRefOid: string;
				baseRefName: string;
				headRepository: { nameWithOwner: string } | null;
				commits: {
					nodes: Array<{ commit: { status: { context: StatusContextNode | null } | null } }>;
				};
			}>;
		};
	};
}

interface LabeledMergesData {
	repository: {
		pullRequests: {
			pageInfo: { hasNextPage: boolean; endCursor: string | null };
			nodes: Array<{ number: number; mergeCommit: { oid: string } | null }>;
		};
	};
}

interface CommitStatusData {
	repository: {
		object: { status: { context: StatusContextNode | null } | null } | null;
	};
}

const OPEN_PULLS_QUERY = `
	query ($owner: String!, $name: String!, $base: String!, $context: String!, $cursor: String) {
		repository(owner: $owner, name: $name) {
			pullRequests(states: OPEN, baseRefName: $base, first: 100, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
				pageInfo { hasNextPage endCursor }
				nodes {
					number
					isDraft
					headRefOid
					baseRefName
					headRepository { nameWithOwner }
					commits(last: 1) {
						nodes { commit { status { context(name: $context) { state description targetUrl creator { login } } } } }
					}
				}
			}
		}
	}
`;

const LABELED_MERGES_QUERY = `
	query ($owner: String!, $name: String!, $base: String!, $label: String!, $cursor: String) {
		repository(owner: $owner, name: $name) {
			pullRequests(states: MERGED, baseRefName: $base, labels: [$label], first: 50, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
				pageInfo { hasNextPage endCursor }
				nodes { number mergeCommit { oid } }
			}
		}
	}
`;

const COMMIT_STATUS_QUERY = `
	query ($owner: String!, $name: String!, $oid: GitObjectID!, $context: String!) {
		repository(owner: $owner, name: $name) {
			object(oid: $oid) {
				... on Commit { status { context(name: $context) { state description targetUrl creator { login } } } }
			}
		}
	}
`;

/** Lists open PRs against `base` with each head's latest status for `context`, one page per 100 PRs. */
export async function listOpenPulls(
	api: ApiClient,
	repo: string,
	input: { base: string; context: string },
): Promise<OpenPull[]> {
	const [owner, name] = repo.split('/');
	const pulls: OpenPull[] = [];
	let cursor: string | null = null;
	for (;;) {
		const data: OpenPullsData = await api.graphql<OpenPullsData>(OPEN_PULLS_QUERY, {
			owner,
			name,
			base: input.base,
			context: input.context,
			cursor,
		});
		const page = data.repository.pullRequests;
		for (const node of page.nodes) {
			pulls.push({
				number: node.number,
				headSha: node.headRefOid,
				isDraft: node.isDraft,
				baseRef: node.baseRefName,
				headRepo: node.headRepository?.nameWithOwner ?? null,
				status: toRecord(node.commits.nodes[0]?.commit.status?.context ?? null),
			});
		}
		if (!page.pageInfo.hasNextPage) {
			return pulls;
		}
		cursor = page.pageInfo.endCursor;
	}
}

/** Merge commits of every merged PR against `base` that carries `label`, newest first, exhaustively. */
export async function listLabeledMergeCommits(
	api: ApiClient,
	repo: string,
	input: { base: string; label: string },
): Promise<string[]> {
	const [owner, name] = repo.split('/');
	const oids: string[] = [];
	let cursor: string | null = null;
	for (;;) {
		const data: LabeledMergesData = await api.graphql<LabeledMergesData>(LABELED_MERGES_QUERY, {
			owner,
			name,
			base: input.base,
			label: input.label,
			cursor,
		});
		const page = data.repository.pullRequests;
		for (const node of page.nodes) {
			if (node.mergeCommit) {
				oids.push(node.mergeCommit.oid);
			}
		}
		if (!page.pageInfo.hasNextPage) {
			return oids;
		}
		cursor = page.pageInfo.endCursor;
	}
}

/** The latest status for `context` on one commit; null when there is none. */
export async function readCommitStatus(
	api: ApiClient,
	repo: string,
	input: { sha: string; context: string },
): Promise<StatusRecord | null> {
	const [owner, name] = repo.split('/');
	const data = await api.graphql<CommitStatusData>(COMMIT_STATUS_QUERY, {
		owner,
		name,
		oid: input.sha,
		context: input.context,
	});
	return toRecord(data.repository.object?.status?.context ?? null);
}

/** Reads one PR through REST; null when it does not exist. */
export async function getPull(
	api: ApiClient,
	repo: string,
	number: number,
): Promise<PullInfo | null> {
	try {
		const pull = await api.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
			...repoParts(repo),
			pull_number: number,
		});
		return {
			number: pull.data.number,
			state: pull.data.state,
			merged: pull.data.merged,
			headSha: pull.data.head.sha,
			baseRef: pull.data.base.ref,
		};
	} catch (error) {
		if (isGitHubError(error, 'not-found')) {
			return null;
		}
		throw error;
	}
}

function toRecord(node: StatusContextNode | null): StatusRecord | null {
	if (node === null) {
		return null;
	}
	return {
		state: node.state.toLowerCase() as StatusState,
		description: node.description,
		targetUrl: node.targetUrl,
		creator: node.creator?.login ?? null,
	};
}
