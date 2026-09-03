import { describe, expect, it } from 'vitest';
import { fetchPullHeads } from '../../src/git/ancestry.ts';
import { chunks, fetchMissingCommits, GitError, type GitRepo } from '../../src/git/repo.ts';

const oid = (number: number): string => number.toString(16).padStart(40, '0');

/** A scripted repository: ls-remote advertises one OID per PR, fetches fail per SHA as configured, nothing is present. */
function scripted(input: { failures: Record<string, string>; present?: string[] }): {
	repo: GitRepo;
	commands: string[][];
} {
	const commands: string[][] = [];
	const present = new Set(input.present ?? []);
	const repo: GitRepo = {
		dir: '/scripted',
		remote: 'origin',
		url: null,
		git(args) {
			commands.push(args);
			if (args[0] === 'ls-remote') {
				return Promise.resolve(
					args
						.slice(3)
						.map((ref) => `${oid(Number(/\d+/.exec(ref)?.[0]))}\t${ref}`)
						.join('\n'),
				);
			}
			if (args[0] === 'cat-file') {
				const sha = (args.at(-1) as string).replace('^{commit}', '');
				return present.has(sha)
					? Promise.resolve('')
					: Promise.reject(new GitError(args, 'missing', 1));
			}
			if (args[0] === 'fetch') {
				const shas = args.slice(args.indexOf('--') + 2);
				const failing = shas.find((sha) => input.failures[sha] !== undefined);
				if (failing !== undefined) {
					return Promise.reject(new GitError(args, input.failures[failing] as string, 128));
				}
				return Promise.resolve('');
			}
			return Promise.reject(new GitError(args, 'unexpected', 1));
		},
	};
	return { repo, commands };
}

describe('fetchPullHeads', () => {
	it('reports a head the remote no longer offers as null and the rest by their advertised SHA', async () => {
		const { repo } = scripted({
			failures: { [oid(2)]: 'fatal: remote error: upload-pack: not our ref ' + oid(2) },
		});
		const heads = await fetchPullHeads(repo, [1, 2]);
		expect(heads.get(1)).toBe(oid(1));
		expect(heads.get(2)).toBeNull();
	});

	it('throws any other per-SHA failure instead of guessing', async () => {
		const { repo } = scripted({
			failures: { [oid(2)]: 'fatal: unable to access: could not resolve host' },
		});
		await expect(fetchPullHeads(repo, [1, 2])).rejects.toThrow(/could not resolve host/);
	});

	it('propagates an invalid refspec instead of treating it as an absent head', async () => {
		const { repo } = scripted({ failures: { [oid(2)]: 'fatal: invalid refspec' } });
		await expect(fetchPullHeads(repo, [1, 2])).rejects.toThrow(/invalid refspec/);
	});

	it('retries only the batch that failed, one SHA at a time, and skips commits already present', async () => {
		// 202 PRs, one already present: 201 SHAs to fetch, so two batches, and the second one fails.
		const pulls = Array.from({ length: 202 }, (_, index) => index + 1);
		const { repo, commands } = scripted({
			failures: { [oid(202)]: "fatal: couldn't find remote ref " + oid(202) },
			present: [oid(1)],
		});
		const heads = await fetchPullHeads(repo, pulls);
		expect(heads.get(1)).toBe(oid(1));
		expect(heads.get(202)).toBeNull();
		const fetches = commands.filter((args) => args[0] === 'fetch');
		// One fetch per batch, plus one retry per SHA of the batch that failed.
		const batches = chunks(pulls.slice(1).map(oid));
		const failed = batches.find((batch) => batch.includes(oid(202))) ?? [];
		expect(batches.length).toBeGreaterThan(1);
		expect(fetches).toHaveLength(batches.length + failed.length);
		expect(fetches[0]).not.toContain(oid(1));
	});
});

describe('presence probes', () => {
	it('run with lazy fetching disabled and only then fetch the missing commits in one batch', async () => {
		const probes: Array<Record<string, string> | undefined> = [];
		const fetches: string[][] = [];
		const repo: GitRepo = {
			dir: '/scripted',
			remote: 'origin',
			url: null,
			git(args, extraEnv) {
				if (args[0] === 'cat-file') {
					probes.push(extraEnv);
					return Promise.reject(new GitError(args, 'missing', 1));
				}
				if (args[0] === 'fetch') {
					fetches.push(args);
					return Promise.resolve('');
				}
				return Promise.reject(new GitError(args, 'unexpected', 1));
			},
		};
		await fetchMissingCommits(repo, ['a'.repeat(40), 'b'.repeat(40)]);
		expect(probes).toEqual([{ GIT_NO_LAZY_FETCH: '1' }, { GIT_NO_LAZY_FETCH: '1' }]);
		expect(fetches).toHaveLength(1);
		expect(fetches[0]?.slice(-2)).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
	});
});

describe('argument hygiene', () => {
	it('separates the remote from options with --', async () => {
		const commands: string[][] = [];
		const repo: GitRepo = {
			dir: '/scripted',
			remote: 'origin',
			url: '/tmp/acme/widgets',
			git(args) {
				commands.push(args);
				return args[0] === 'cat-file'
					? Promise.reject(new GitError(args, 'x', 1))
					: Promise.resolve('');
			},
		};
		await fetchMissingCommits(repo, ['a'.repeat(40)]);
		const fetch = commands.find((args) => args[0] === 'fetch');
		expect(fetch?.slice(-3)).toEqual(['--', '/tmp/acme/widgets', 'a'.repeat(40)]);
	});
});
