import type { Ancestry, Logger } from '../types.ts';
import { repoParts, type ApiClient } from './api.ts';

/** The compare API lists at most this many files and never says when it truncated. */
export const COMPARE_FILE_CAP = 300;

/** Ancestry through the compare endpoint; one REST request per question, memoized per run. */
export function createApiAncestry(api: ApiClient, repo: string, logger: Logger): Ancestry {
	const parts = repoParts(repo);
	const answers = new Map<string, boolean>();
	return {
		name: 'api',
		async isAncestor(ancestor, descendant) {
			if (ancestor === descendant) {
				return true;
			}
			const key = `${ancestor}..${descendant}`;
			const cached = answers.get(key);
			if (cached !== undefined) {
				return cached;
			}
			const compare = await api.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
				...parts,
				basehead: `${ancestor}...${descendant}`,
				per_page: 1,
			});
			// 'ahead' means the descendant builds on the ancestor; 'identical' is the edge.
			const answer = compare.data.status === 'ahead' || compare.data.status === 'identical';
			answers.set(key, answer);
			return answer;
		},
		async changedFiles(from, to) {
			if (from === to) {
				return [];
			}
			const compare = await api.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
				...parts,
				basehead: `${from}...${to}`,
			});
			const files = compare.data.files ?? [];
			if (files.length >= COMPARE_FILE_CAP) {
				logger.warn(
					`Compare ${from.slice(0, 12)}...${to.slice(0, 12)} returned ${files.length} files; the list may be truncated, so path decisions are indeterminate.`,
				);
				return null;
			}
			const names = new Set<string>();
			for (const file of files) {
				names.add(file.filename);
				if (file.previous_filename !== undefined) {
					names.add(file.previous_filename);
				}
			}
			return [...names];
		},
	};
}
