import { execFileSync, spawnSync } from 'node:child_process';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	cleanup,
	isNewer,
	messageMatches,
	parseVersion,
	prepare,
	promote,
	releaseMessage,
	type Options,
} from '../scripts/tag-action-mirror.ts';

const UPSTREAM = 'a'.repeat(40);

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Test',
			GIT_AUTHOR_EMAIL: 't@example.com',
			GIT_COMMITTER_NAME: 'Test',
			GIT_COMMITTER_EMAIL: 't@example.com',
		},
	}).trim();
}

function releaseFiles(version: string): Record<string, string> {
	return {
		'action.yml': `name: PR Baseline\nruns:\n  using: node24\n  main: dist/index.js\n`,
		'dist/index.js': `// bundle for v${version}\n`,
		'release.json': `{ "version": "${version}", "upstream": "${UPSTREAM}" }\n`,
	};
}

/** A bare mirror plus a working clone standing in for the deploy step. */
class Fixture {
	readonly root = mkdtempSync(join(tmpdir(), 'mirror-test-'));
	readonly bare = join(this.root, 'mirror.git');
	readonly clone = join(this.root, 'clone');
	readonly url = pathToFileURL(this.bare).href;
	private states = 0;

	constructor() {
		git(this.root, 'init', '--bare', '--quiet', '--initial-branch=main', this.bare);
		git(this.root, 'clone', '--quiet', this.bare, this.clone);
		git(this.clone, 'commit', '--quiet', '--allow-empty', '-m', 'Initial commit');
		git(this.clone, 'push', '--quiet', 'origin', 'HEAD:main');
	}

	options(version: string, upstream = UPSTREAM, files = releaseFiles(version)): Options {
		const stage = mkdtempSync(join(this.root, 'stage-'));
		this.write(stage, files);
		return {
			mirror: this.url,
			version,
			upstream,
			stage,
			state: join(this.root, `state-${version}-${this.states++}.json`),
			work: mkdtempSync(join(this.root, 'work-')),
		};
	}

	private write(directory: string, files: Record<string, string>): void {
		for (const [name, content] of Object.entries(files)) {
			mkdirSync(join(directory, name, '..'), { recursive: true });
			writeFileSync(join(directory, name), content);
		}
	}

	/** Commits on the given branch of the mirror the way the deploy action would: the tree replaced by `files`. */
	deploy(branch: string, message: string, files?: Record<string, string>): string {
		git(this.clone, 'fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/deploy/${branch}`);
		git(this.clone, 'checkout', '--quiet', '--detach', `refs/deploy/${branch}`);
		if (files !== undefined) {
			for (const entry of readdirSync(this.clone)) {
				if (entry !== '.git') {
					rmSync(join(this.clone, entry), { recursive: true, force: true });
				}
			}
			this.write(this.clone, files);
			git(this.clone, 'add', '--all');
		}
		git(this.clone, 'commit', '--quiet', '--allow-empty', '-m', message);
		git(this.clone, 'push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${branch}`);
		return git(this.clone, 'rev-parse', 'HEAD');
	}

	ref(name: string): string | undefined {
		try {
			return git(this.bare, 'rev-parse', '--verify', '--quiet', `${name}^{commit}`);
		} catch {
			return undefined;
		}
	}

	refs(): string[] {
		return git(this.bare, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean);
	}

	file(ref: string, path: string): string {
		return git(this.bare, 'show', `${ref}:${path}`);
	}

	/** A full publication the way the workflow runs it: prepare, the deploy action, promote, cleanup. */
	release(version: string): string {
		const files = releaseFiles(version);
		const options = this.options(version, UPSTREAM, files);
		const state = prepare(options);
		if (state.path !== 'publish') {
			const resumed = promote(options);
			cleanup(options);
			return resumed.releaseSha as string;
		}
		const deployed = this.deployRelease(state.branch, version, files);
		const promoted = promote({ ...options, deployed });
		cleanup({ ...options, deployed });
		return promoted.releaseSha as string;
	}

	/** What the deploy action leaves on the release branch: the staged files as one commit with the release message. */
	deployRelease(
		branch: string,
		version: string,
		files = releaseFiles(version),
		upstream = UPSTREAM,
	): string {
		return this.deploy(branch.replace('refs/heads/', ''), releaseMessage(version, upstream), files);
	}

	dispose(): void {
		rmSync(this.root, { recursive: true, force: true });
	}
}

describe('version helpers', () => {
	it('parses and compares release versions', () => {
		expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
		expect(() => parseVersion('1.2')).toThrow('Not a release version');
		expect(isNewer(parseVersion('1.10.0'), parseVersion('1.9.9'))).toBe(true);
		expect(isNewer(parseVersion('2.0.0'), parseVersion('2.0.0'))).toBe(false);
	});

	it('requires the subject and the Upstream-Ref footer verbatim', () => {
		expect(messageMatches(releaseMessage('1.0.0', UPSTREAM), '1.0.0', UPSTREAM)).toBe(true);
		expect(messageMatches('Release v1.0.0\n\nUpstream-Ref: other', '1.0.0', UPSTREAM)).toBe(false);
		expect(
			messageMatches(`chore: Release v1.0.0\n\nUpstream-Ref: ${UPSTREAM}`, '1.0.0', UPSTREAM),
		).toBe(false);
	});
});

describe('tag-action-mirror', () => {
	let fixture: Fixture;
	beforeEach(() => {
		fixture = new Fixture();
	});
	afterEach(() => {
		fixture.dispose();
	});

	it('publishes a first release: main and both tags move to the deployed commit, which carries the staged tree', () => {
		const initial = fixture.ref('refs/heads/main');
		const sha = fixture.release('1.0.0');
		expect(fixture.ref('refs/heads/main')).toBe(sha);
		expect(fixture.ref('refs/tags/v1.0.0')).toBe(sha);
		expect(fixture.ref('refs/tags/v1')).toBe(sha);
		expect(fixture.refs()).not.toContain('refs/heads/release/v1.0.0');
		expect(git(fixture.bare, 'rev-parse', `${sha}^`)).toBe(initial);
		expect(fixture.file(sha, 'release.json')).toContain('"version": "1.0.0"');
	});

	it('promotes what the deploy action left: one commit on the recorded main carrying the staged tree', () => {
		const options = fixture.options('1.0.0');
		const state = prepare(options);
		const deployed = fixture.deployRelease(state.branch, '1.0.0');
		expect(fixture.ref(state.branch)).toBe(deployed);
		expect(git(fixture.bare, 'rev-parse', `${deployed}^`)).toBe(state.mainSha);
		expect(git(fixture.bare, 'log', '-1', '--format=%P', deployed).split(' ')).toHaveLength(1);
		expect(git(fixture.bare, 'log', '-1', '--format=%B', deployed)).toContain(
			releaseMessage('1.0.0', UPSTREAM),
		);
		expect(fixture.file(deployed, 'release.json')).toContain('"version": "1.0.0"');
		expect(promote({ ...options, deployed }).releaseSha).toBe(deployed);
		expect(fixture.ref('refs/heads/main')).toBe(deployed);
	});

	it('refuses to promote a publish without the commit the deploy step reported', () => {
		const options = fixture.options('1.0.0');
		const state = prepare(options);
		fixture.deployRelease(state.branch, '1.0.0');
		expect(() => promote(options)).toThrow('--deployed is required');
		expect(fixture.ref('refs/heads/main')).toBe(state.mainSha);
	});

	it('refuses a stage that is empty, a link, or holds a nested repository, and one that is missing', () => {
		const options = fixture.options('1.0.0');
		const state = prepare(options);
		const deployed = fixture.deployRelease(state.branch, '1.0.0');
		const empty = mkdtempSync(join(fixture.root, 'empty-'));
		expect(() => promote({ ...options, deployed, stage: empty })).toThrow('is empty');
		const link = join(fixture.root, 'stage-link');
		symlinkSync(options.stage as string, link);
		expect(() => promote({ ...options, deployed, stage: link })).toThrow('is a link');
		expect(() =>
			promote({ ...options, deployed, stage: join(fixture.root, 'missing-stage') }),
		).toThrow('does not exist');
		const nested = options.stage as string;
		mkdirSync(join(nested, 'vendor', '.git'), { recursive: true });
		writeFileSync(join(nested, 'vendor', '.git', 'HEAD'), 'ref: refs/heads/main\n');
		expect(() => promote({ ...options, deployed })).toThrow('nested repository');
		expect(fixture.ref('refs/heads/main')).toBe(state.mainSha);
	});

	it('refuses to promote when the branch no longer holds the commit the deploy step reported', () => {
		const options = fixture.options('1.0.0');
		const state = prepare(options);
		const deployed = fixture.deployRelease(state.branch, '1.0.0');
		const taken = fixture.deploy(
			state.branch.replace('refs/heads/', ''),
			releaseMessage('1.0.0', UPSTREAM),
			releaseFiles('1.0.0'),
		);
		expect(() => promote({ ...options, deployed })).toThrow(
			'does not hold the commit the deploy step reported',
		);
		expect(fixture.ref('refs/tags/v1.0.0')).toBeUndefined();
		// The branch is not this run's any more, so cleanup leaves it alone.
		cleanup({ ...options, deployed });
		expect(fixture.ref(state.branch)).toBe(taken);
	});

	it('cleans up the reported commit when promote never ran', () => {
		const options = fixture.options('1.0.0');
		const state = prepare(options);
		const deployed = fixture.deployRelease(state.branch, '1.0.0');
		cleanup({ ...options, deployed });
		expect(fixture.refs()).not.toContain(state.branch);
		expect(fixture.ref('refs/heads/main')).toBe(state.mainSha);
	});

	it('refuses a deployed tree that drops a mode the staged directory carries', () => {
		const options = fixture.options('1.0.0');
		const stage = options.stage as string;
		writeFileSync(join(stage, 'run.sh'), '#!/bin/sh\n');
		chmodSync(join(stage, 'run.sh'), 0o755);
		symlinkSync('README.md', join(stage, 'link.md'));
		const state = prepare(options);
		// The fixture writes plain files, so the deployed tree differs from the stage in exactly those two entries.
		const deployed = fixture.deployRelease(state.branch, '1.0.0', {
			...releaseFiles('1.0.0'),
			'run.sh': '#!/bin/sh\n',
			'link.md': 'README.md',
		});
		expect(() => promote({ ...options, deployed })).toThrow('does not reproduce the staged tree');
		expect(fixture.ref('refs/heads/main')).toBe(state.mainSha);
	});

	it('does not promote a commit that replaced the deployed one, even when it passes every content check', () => {
		const options = fixture.options('1.0.0');
		const state = prepare(options);
		const deployed = fixture.deployRelease(state.branch, '1.0.0');
		const tree = git(fixture.bare, 'rev-parse', `${deployed}^{tree}`);
		// A fixed date, so the twin is a different commit than the one the deploy step left a moment earlier.
		const twin = execFileSync(
			'git',
			['commit-tree', tree, '-p', state.mainSha, '-m', releaseMessage('1.0.0', UPSTREAM)],
			{
				cwd: fixture.bare,
				encoding: 'utf8',
				env: {
					...process.env,
					GIT_AUTHOR_NAME: 'Test',
					GIT_AUTHOR_EMAIL: 't@example.com',
					GIT_COMMITTER_NAME: 'Test',
					GIT_COMMITTER_EMAIL: 't@example.com',
					GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
					GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
				},
			},
		).trim();
		git(fixture.bare, 'update-ref', state.branch, twin);
		expect(() => promote({ ...options, deployed })).toThrow(
			'does not hold the commit the deploy step reported',
		);
		expect(fixture.ref('refs/tags/v1.0.0')).toBeUndefined();
		// Cleanup leaves the foreign commit alone: it is not one this run recorded.
		cleanup({ ...options, deployed });
		expect(fixture.ref(state.branch)).toBe(twin);
	});

	it('does not leak the credential into a failing local git command', () => {
		const options = {
			...fixture.options('1.0.0'),
			mirror: 'https://example.invalid/owner/repo.git',
			token: 'ghs_secret_value_123',
		};
		const basic = Buffer.from('x-access-token:ghs_secret_value_123').toString('base64');
		let message = '';
		try {
			prepare(options);
		} catch (error) {
			message = String(error);
		}
		expect(message).toContain('git ls-remote failed');
		expect(message).not.toContain('ghs_secret_value_123');
		expect(message).not.toContain(basic);
	});

	it('deploys nothing on the resume path', () => {
		const sha = fixture.release('1.0.0');
		const options = fixture.options('1.0.0');
		expect(prepare(options).path).toBe('resume');
		expect(promote(options).path).toBe('resume');
		expect(fixture.ref('refs/heads/main')).toBe(sha);
		expect(fixture.refs()).not.toContain('refs/heads/release/v1.0.0');
	});

	it('advances the major tag on later releases and creates a new one on a major bump', () => {
		fixture.release('1.0.0');
		const second = fixture.release('1.1.0');
		expect(fixture.ref('refs/tags/v1')).toBe(second);
		const major = fixture.release('2.0.0');
		expect(fixture.ref('refs/tags/v2')).toBe(major);
		expect(fixture.ref('refs/tags/v1')).toBe(second);
		expect(fixture.file('refs/tags/v2', 'dist/index.js')).toContain('v2.0.0');
	});

	it('advances an annotated major tag through a lease on the tag object', () => {
		const first = fixture.release('1.0.0');
		git(fixture.bare, 'tag', '-d', 'v1');
		git(fixture.bare, 'tag', '-a', '-m', 'v1', 'v1', first);
		const second = fixture.release('1.0.1');
		expect(fixture.ref('refs/tags/v1')).toBe(second);
	});

	it('refuses to publish a version older than the one the major tag points at', () => {
		fixture.release('1.2.0');
		expect(() => prepare(fixture.options('1.1.5'))).toThrow('not older than v1.1.5');
		expect(fixture.refs()).not.toContain('refs/heads/release/v1.1.5');
	});

	it('resumes when the version tag exists: reconciles the major tag and drops a leftover branch, without a deploy', () => {
		const sha = fixture.release('1.0.0');
		git(fixture.bare, 'update-ref', '-d', 'refs/tags/v1');
		git(fixture.bare, 'update-ref', 'refs/heads/release/v1.0.0', sha);
		const state = prepare(fixture.options('1.0.0'));
		expect(state).toMatchObject({ path: 'resume', branchCreated: false, releaseSha: sha });
		expect(fixture.ref('refs/tags/v1')).toBe(sha);
		expect(fixture.refs()).not.toContain('refs/heads/release/v1.0.0');
	});

	it('treats a rerun of a finished release as a no-op resume', () => {
		const sha = fixture.release('1.0.0');
		const before = fixture.refs();
		const options = fixture.options('1.0.0');
		expect(prepare(options)).toMatchObject({ path: 'resume', releaseSha: sha });
		expect(promote(options).path).toBe('resume');
		cleanup(options);
		expect(fixture.refs()).toEqual(before);
	});

	it('resumes a superseded release without moving the major tag back', () => {
		fixture.release('1.0.0');
		fixture.release('1.1.0');
		const before = fixture.refs();
		const options = fixture.options('1.0.0');
		expect(prepare(options)).toMatchObject({ path: 'resume' });
		expect(promote(options).path).toBe('resume');
		cleanup(options);
		expect(fixture.refs()).toEqual(before);
		expect(fixture.ref('refs/tags/v1')).toBe(fixture.ref('refs/tags/v1.1.0'));
	});

	it('resumes a superseded release when the major tag is annotated at the newer release', () => {
		fixture.release('1.0.0');
		const newer = fixture.release('1.1.0');
		git(fixture.bare, 'tag', '-d', 'v1');
		git(fixture.bare, 'tag', '-a', '-m', 'v1', 'v1', newer);
		const before = fixture.refs();
		const tagObject = git(fixture.bare, 'rev-parse', 'refs/tags/v1');
		expect(prepare(fixture.options('1.0.0'))).toMatchObject({ path: 'resume' });
		expect(fixture.refs()).toEqual(before);
		expect(fixture.ref('refs/tags/v1')).toBe(newer);
		expect(git(fixture.bare, 'rev-parse', 'refs/tags/v1')).toBe(tagObject);
	});

	it('refuses a resume when the major tag descends from the release but is not on main', () => {
		const sha = fixture.release('1.0.0');
		fixture.release('1.1.0');
		git(fixture.bare, 'update-ref', 'refs/heads/stray', sha);
		const stray = fixture.deploy('stray', 'Release v1.2.0\n\nUpstream-Ref: ' + 'a'.repeat(40));
		git(fixture.bare, 'update-ref', 'refs/tags/v1', stray);
		git(fixture.bare, 'update-ref', '-d', 'refs/heads/stray');
		expect(() => prepare(fixture.options('1.0.0'))).toThrow('not an ancestor of v1.0.0');
	});

	it('refuses a resume when the major tag is on a release of another major or one that is not newer', () => {
		fixture.release('1.0.0');
		for (const subject of ['Release v2.0.0', 'Release v1.0.0']) {
			const other = fixture.deploy('main', `${subject}\n\nUpstream-Ref: ${'a'.repeat(40)}`);
			git(fixture.bare, 'update-ref', 'refs/tags/v1', other);
			expect(() => prepare(fixture.options('1.0.0'))).toThrow('not an ancestor of v1.0.0');
		}
	});

	it('refuses a resume when the major tag is on an untagged commit that only claims to be a newer release', () => {
		fixture.release('1.0.0');
		const claimed = fixture.deploy('main', `Release v1.1.0\n\nUpstream-Ref: ${'a'.repeat(40)}`);
		git(fixture.bare, 'update-ref', 'refs/tags/v1', claimed);
		expect(() => prepare(fixture.options('1.0.0'))).toThrow('not an ancestor of v1.0.0');
	});

	it('names the major tag release as its subject spells it when refusing an older version', () => {
		fixture.release('1.0.0');
		const padded = fixture.deploy(
			'main',
			`Release v01.002.0003\n\nUpstream-Ref: ${'a'.repeat(40)}`,
		);
		git(fixture.bare, 'update-ref', 'refs/tags/v1', padded);
		expect(() => prepare(fixture.options('1.1.0'))).toThrow(
			'v1 already points at v01.002.0003, which is not older than v1.1.0.',
		);
	});

	it('refuses a resume when the major tag is on a descendant that is not a release commit', () => {
		fixture.release('1.0.0');
		fixture.release('1.1.0');
		const plain = fixture.deploy('main', 'Not a release');
		git(fixture.bare, 'update-ref', 'refs/tags/v1', plain);
		expect(() => prepare(fixture.options('1.0.0'))).toThrow('not an ancestor of v1.0.0');
	});

	it('rejects a resume when the existing tag points at a merge commit, and does not move the major tag', () => {
		const first = fixture.release('1.0.0');
		git(fixture.bare, 'update-ref', 'refs/heads/other', first);
		const other = fixture.deploy('other', 'Other history');
		git(fixture.bare, 'update-ref', '-d', 'refs/heads/other');
		const tree = git(fixture.bare, 'rev-parse', `${first}^{tree}`);
		const merge = git(
			fixture.bare,
			'commit-tree',
			tree,
			'-p',
			first,
			'-p',
			other,
			'-m',
			releaseMessage('1.1.0', UPSTREAM),
		);
		git(fixture.bare, 'update-ref', 'refs/heads/main', merge);
		git(fixture.bare, 'update-ref', 'refs/tags/v1.1.0', merge);
		expect(() => prepare(fixture.options('1.1.0'))).toThrow('not this release');
		expect(fixture.ref('refs/tags/v1')).toBe(first);
		// The merge is also no superseding release for a rerun of 1.0.0.
		git(fixture.bare, 'update-ref', 'refs/tags/v1', merge);
		expect(() => prepare(fixture.options('1.0.0'))).toThrow('not an ancestor of v1.0.0');
	});

	it('rejects a resume when the existing tag is not this release', () => {
		fixture.release('1.0.0');
		expect(() => prepare(fixture.options('1.0.0', 'b'.repeat(40)))).toThrow('not this release');
	});

	it('refuses a branch another run left behind, and cleanup never deletes a branch this run did not create', () => {
		const first = fixture.options('1.0.0');
		prepare(first);
		const main = fixture.ref('refs/heads/main');
		expect(fixture.ref('refs/heads/release/v1.0.0')).toBe(main);
		const rerun = fixture.options('1.0.0');
		expect(() => prepare(rerun)).toThrow('delete it by hand');
		cleanup(rerun);
		expect(fixture.ref('refs/heads/release/v1.0.0')).toBe(main);
		cleanup(first);
		expect(fixture.refs()).not.toContain('refs/heads/release/v1.0.0');
	});

	it("loses the race for the branch to a concurrent run without touching that run's branch", () => {
		const options = fixture.options('1.0.0');
		const main = fixture.ref('refs/heads/main') as string;
		options.hooks = {
			beforeCreate: () => git(fixture.bare, 'update-ref', 'refs/heads/release/v1.0.0', main),
		};
		expect(() => prepare(options)).toThrow('created by another run');
		cleanup(options);
		expect(fixture.ref('refs/heads/release/v1.0.0')).toBe(main);
	});

	it('does not promote a commit with the wrong message, and cleanup removes the deploy commit', () => {
		const main = fixture.ref('refs/heads/main');
		const options = fixture.options('1.0.0');
		prepare(options);
		const deployed = fixture.deploy('release/v1.0.0', 'Release v1.0.0', releaseFiles('1.0.0'));
		expect(() => promote({ ...options, deployed })).toThrow('Upstream-Ref');
		expect(fixture.ref('refs/heads/main')).toBe(main);
		expect(fixture.ref('refs/tags/v1.0.0')).toBeUndefined();
		cleanup(options);
		expect(fixture.refs()).not.toContain('refs/heads/release/v1.0.0');
	});

	it('does not promote a commit whose tree differs from the staged directory', () => {
		const main = fixture.ref('refs/heads/main');
		const options = fixture.options('1.0.0');
		prepare(options);
		const tampered = { ...releaseFiles('1.0.0'), 'dist/index.js': '// something else\n' };
		const deployed = fixture.deploy('release/v1.0.0', releaseMessage('1.0.0', UPSTREAM), tampered);
		expect(() => promote({ ...options, deployed })).toThrow('staged tree');
		expect(fixture.ref('refs/heads/main')).toBe(main);
		expect(fixture.ref('refs/tags/v1.0.0')).toBeUndefined();
		cleanup(options);
		expect(fixture.refs()).not.toContain('refs/heads/release/v1.0.0');
	});

	it('does not promote a commit whose parent is not the recorded main', () => {
		const options = fixture.options('1.0.0');
		const state = prepare(options);
		const other = fixture.deploy('release/v1.0.0', 'Rewritten base');
		git(fixture.bare, 'update-ref', state.branch, other);
		const deployed = fixture.deploy(
			'release/v1.0.0',
			releaseMessage('1.0.0', UPSTREAM),
			releaseFiles('1.0.0'),
		);
		expect(() => promote({ ...options, deployed })).toThrow(
			'not a single commit on top of the main',
		);
		expect(fixture.ref('refs/tags/v1.0.0')).toBeUndefined();
	});

	it('does not promote a merge commit, even with the right tree and first parent', () => {
		const options = fixture.options('1.0.0');
		const state = prepare(options);
		const single = fixture.deploy(
			'release/v1.0.0',
			releaseMessage('1.0.0', UPSTREAM),
			releaseFiles('1.0.0'),
		);
		git(fixture.bare, 'update-ref', 'refs/heads/other', state.mainSha);
		const other = fixture.deploy('other', 'Other history');
		git(fixture.bare, 'update-ref', '-d', 'refs/heads/other');
		const tree = git(fixture.bare, 'rev-parse', `${single}^{tree}`);
		const merge = git(
			fixture.bare,
			'commit-tree',
			tree,
			'-p',
			state.mainSha,
			'-p',
			other,
			'-m',
			releaseMessage('1.0.0', UPSTREAM),
		);
		git(fixture.bare, 'update-ref', state.branch, merge);
		expect(() => promote({ ...options, deployed: merge })).toThrow(
			'not a single commit on top of the main',
		);
		expect(fixture.ref('refs/tags/v1.0.0')).toBeUndefined();
		expect(fixture.ref('refs/heads/main')).toBe(state.mainSha);
	});

	it('does not promote when main moved after prepare', () => {
		const options = fixture.options('1.0.0');
		prepare(options);
		const moved = fixture.deploy('main', 'Unrelated change');
		const deployed = fixture.deploy(
			'release/v1.0.0',
			releaseMessage('1.0.0', UPSTREAM),
			releaseFiles('1.0.0'),
		);
		expect(() => promote({ ...options, deployed })).toThrow('git push failed');
		expect(fixture.ref('refs/heads/main')).toBe(moved);
		expect(fixture.ref('refs/tags/v1.0.0')).toBeUndefined();
	});

	it('does not promote when the version tag appeared meanwhile', () => {
		const main = fixture.ref('refs/heads/main') as string;
		const options = fixture.options('1.0.0');
		prepare(options);
		const deployed = fixture.deploy(
			'release/v1.0.0',
			releaseMessage('1.0.0', UPSTREAM),
			releaseFiles('1.0.0'),
		);
		git(fixture.bare, 'update-ref', 'refs/tags/v1.0.0', main);
		expect(() => promote({ ...options, deployed })).toThrow('appeared');
		expect(fixture.ref('refs/heads/main')).toBe(main);
	});

	it('refuses a divergent major tag before touching main or creating the version tag', () => {
		fixture.release('1.0.0');
		const stray = fixture.deploy('main', 'Manual commit on main');
		git(fixture.bare, 'update-ref', 'refs/tags/v1', stray);
		const released = fixture.ref('refs/tags/v1.0.0') as string;
		git(fixture.bare, 'update-ref', 'refs/heads/main', released);
		const options = fixture.options('1.0.1');
		const state = prepare(options);
		const deployed = fixture.deploy(
			state.branch.replace('refs/heads/', ''),
			releaseMessage('1.0.1', UPSTREAM),
			releaseFiles('1.0.1'),
		);
		expect(() => promote({ ...options, deployed })).toThrow('not an ancestor');
		expect(fixture.ref('refs/heads/main')).toBe(released);
		expect(fixture.ref('refs/tags/v1.0.1')).toBeUndefined();
	});

	it('moves nothing when the major tag moves between the read and the atomic push', () => {
		const first = fixture.release('1.0.0');
		const options = fixture.options('1.0.1');
		const state = prepare(options);
		const deployed = fixture.deploy(
			state.branch.replace('refs/heads/', ''),
			releaseMessage('1.0.1', UPSTREAM),
			releaseFiles('1.0.1'),
		);
		const initial = git(fixture.bare, 'rev-parse', `${first}^`);
		options.hooks = { beforePush: () => git(fixture.bare, 'update-ref', 'refs/tags/v1', initial) };
		expect(() => promote({ ...options, deployed })).toThrow('stale info');
		expect(fixture.ref('refs/heads/main')).toBe(first);
		expect(fixture.ref('refs/tags/v1.0.1')).toBeUndefined();
		expect(fixture.ref('refs/tags/v1')).toBe(initial);
	});

	it('recovers when the run dies right after the atomic push, before its state is saved', () => {
		const options = fixture.options('1.0.0');
		const state = prepare(options);
		const deployed = fixture.deploy(
			state.branch.replace('refs/heads/', ''),
			releaseMessage('1.0.0', UPSTREAM),
			releaseFiles('1.0.0'),
		);
		options.hooks = {
			afterPush: () => {
				throw new Error('runner lost');
			},
		};
		expect(() => promote({ ...options, deployed })).toThrow('runner lost');
		expect(fixture.ref('refs/heads/main')).toBe(deployed);
		expect(fixture.ref('refs/tags/v1.0.0')).toBe(deployed);
		expect(fixture.ref('refs/tags/v1')).toBe(deployed);
		const rerun = fixture.options('1.0.0');
		expect(prepare(rerun)).toMatchObject({ path: 'resume', releaseSha: deployed });
		expect(fixture.refs()).not.toContain('refs/heads/release/v1.0.0');
	});

	it('runs as the workflow does: the CLI from a working directory with a relative stage path', () => {
		const cwd = mkdtempSync(join(fixture.root, 'workspace-'));
		const files = releaseFiles('1.0.0');
		for (const [name, content] of Object.entries(files)) {
			mkdirSync(join(cwd, 'mirror-stage', name, '..'), { recursive: true });
			writeFileSync(join(cwd, 'mirror-stage', name), content);
		}
		const script = join(import.meta.dirname, '..', 'scripts', 'tag-action-mirror.ts');
		const cli = (command: string, ...extra: string[]): string => {
			const result = spawnSync(
				process.execPath,
				[
					script,
					command,
					...extra,
					'--mirror',
					fixture.url,
					'--version',
					'1.0.0',
					'--upstream',
					UPSTREAM,
					'--stage',
					'mirror-stage',
					'--state',
					'state.json',
				],
				{ cwd, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: join(cwd, 'outputs.txt') } },
			);
			expect(result.status, result.stderr).toBe(0);
			return result.stdout;
		};
		expect(cli('prepare')).toContain('deploy=true');
		// The action deploys between prepare and promote, and its commit SHA is what the two later steps are given.
		const deployed = fixture.deployRelease('refs/heads/release/v1.0.0', '1.0.0', files);
		expect(cli('promote', '--deployed', deployed)).toContain('release_sha=');
		cli('cleanup', '--deployed', deployed);
		expect(fixture.ref('refs/tags/v1.0.0')).toBe(fixture.ref('refs/heads/main'));
		expect(fixture.ref('refs/heads/main')).toBe(deployed);
		expect(fixture.refs()).not.toContain('refs/heads/release/v1.0.0');
		expect(readFileSync(join(cwd, 'outputs.txt'), 'utf8')).toContain(
			'target_branch=release/v1.0.0',
		);
	});

	it('cleanup leaves a branch alone when it moved to a commit this run never recorded', () => {
		const options = fixture.options('1.0.0');
		prepare(options);
		const foreign = fixture.deploy('release/v1.0.0', 'Someone else');
		cleanup(options);
		expect(fixture.ref('refs/heads/release/v1.0.0')).toBe(foreign);
	});
});
