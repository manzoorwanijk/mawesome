import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FakeGitHub } from './fake-github.ts';

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: 'Test',
	GIT_AUTHOR_EMAIL: 'test@example.test',
	GIT_COMMITTER_NAME: 'Test',
	GIT_COMMITTER_EMAIL: 'test@example.test',
	GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
	GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

/**
 * A real repository trio: an authoring work tree, a bare remote allowing treeless fetches, and a treeless clone.
 * The remote path ends in `acme/widgets` so the adapter's remote check accepts it for the fake's repository name.
 */
export class GitFixture {
	readonly root: string;
	readonly workDir: string;
	readonly remoteDir: string;
	readonly cloneDir: string;
	readonly remoteUrl: string;

	constructor() {
		this.root = mkdtempSync(join(tmpdir(), 'pr-baseline-git-'));
		this.workDir = join(this.root, 'work');
		this.remoteDir = join(this.root, 'remote', 'acme', 'widgets');
		this.cloneDir = join(this.root, 'clone');
		this.remoteUrl = pathToFileURL(this.remoteDir).href;
		mkdirSync(this.remoteDir, { recursive: true });
		this.git(this.remoteDir, ['init', '--quiet', '--bare', '--initial-branch=main']);
		this.git(this.remoteDir, ['config', 'uploadpack.allowFilter', 'true']);
		// GitHub serves reachable commits by SHA (base heads, merge commits, PR heads); the fixture mirrors that.
		this.git(this.remoteDir, ['config', 'uploadpack.allowReachableSHA1InWant', 'true']);
		mkdirSync(this.workDir);
		this.git(this.workDir, ['init', '--quiet', '--initial-branch=main']);
		this.git(this.workDir, ['remote', 'add', 'origin', this.remoteUrl]);
	}

	git(dir: string, args: string[]): string {
		return execFileSync('git', args, {
			cwd: dir,
			encoding: 'utf8',
			env: GIT_ENV,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	}

	/** Commits file changes (null deletes) on the current branch of the work tree and returns the SHA. */
	commit(message: string, files: Record<string, string | null> = {}): string {
		for (const [name, content] of Object.entries(files)) {
			const path = join(this.workDir, name);
			if (content === null) {
				rmSync(path, { force: true });
			} else {
				mkdirSync(join(path, '..'), { recursive: true });
				writeFileSync(path, content);
			}
		}
		this.git(this.workDir, ['add', '-A']);
		this.git(this.workDir, ['commit', '--quiet', '--allow-empty', '-m', message]);
		return this.git(this.workDir, ['rev-parse', 'HEAD']).trim();
	}

	checkout(ref: string, newBranch?: string): void {
		this.git(
			this.workDir,
			newBranch === undefined
				? ['checkout', '--quiet', ref]
				: ['checkout', '--quiet', '-b', newBranch, ref],
		);
	}

	/** Pushes a work-tree ref (or SHA) to a remote ref, force-updating it. */
	push(source: string, target: string): void {
		this.git(this.workDir, ['push', '--quiet', '--force', 'origin', `${source}:${target}`]);
	}

	pull(number: number, sha: string): void {
		this.push(sha, `refs/pull/${number}/head`);
	}

	/** Creates many pull refs at the same commit in one push. */
	pulls(numbers: number[], sha: string): void {
		this.git(this.workDir, [
			'push',
			'--quiet',
			'--force',
			'origin',
			...numbers.map((number) => `${sha}:refs/pull/${number}/head`),
		]);
	}

	deletePull(number: number): void {
		this.git(this.workDir, ['push', '--quiet', 'origin', `:refs/pull/${number}/head`]);
	}

	tag(name: string, sha: string, annotated = false): void {
		this.git(this.workDir, ['tag', '--force', ...(annotated ? ['-a', '-m', name] : []), name, sha]);
		this.push(`refs/tags/${name}`, `refs/tags/${name}`);
	}

	/** Creates the treeless clone the adapter works in; call after the remote has its branches. */
	clone(): string {
		rmSync(this.cloneDir, { recursive: true, force: true });
		this.git(this.root, [
			'clone',
			'--quiet',
			'--filter=tree:0',
			'--no-checkout',
			this.remoteUrl,
			this.cloneDir,
		]);
		return this.cloneDir;
	}

	/** Replaces the clone with a depth-1 shallow clone, as `actions/checkout` produces by default. */
	shallowClone(): string {
		rmSync(this.cloneDir, { recursive: true, force: true });
		this.git(this.root, [
			'clone',
			'--quiet',
			'--depth',
			'1',
			'--no-checkout',
			this.remoteUrl,
			this.cloneDir,
		]);
		return this.cloneDir;
	}

	/** Points the remote's HEAD at another branch, as a repository with a non-main default branch has. */
	setDefaultBranch(branch: string): void {
		this.git(this.remoteDir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
	}

	/** Registers every commit reachable from the remote's refs, plus its branches, in the fake API. */
	mirror(github: FakeGitHub): void {
		const lines = this.git(this.remoteDir, ['rev-list', '--parents', '--all']).trim().split('\n');
		for (const line of lines) {
			const [sha, ...parents] = line.split(' ');
			if (sha !== undefined && sha.length > 0) {
				github.commit(sha, parents);
			}
		}
		const refs = this.git(this.remoteDir, [
			'for-each-ref',
			'--format=%(refname) %(objectname)',
			'refs/heads/',
		]).trim();
		for (const line of refs.split('\n').filter((entry) => entry.length > 0)) {
			const [ref, sha] = line.split(' ');
			if (ref !== undefined && sha !== undefined) {
				github.branch(ref.replace('refs/heads/', ''), sha);
			}
		}
	}

	cleanup(): void {
		rmSync(this.root, { recursive: true, force: true });
	}
}
