import { execFileSync, spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	isNewer,
	parseVersion,
	publish,
	releaseMessage,
	resolveWorkspace,
	stage,
	type PublishOptions,
	type Workspace,
} from '../scripts/deploy-to-mirror.ts';

const UPSTREAM = 'a'.repeat(40);

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function write(directory: string, files: Record<string, string>): void {
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(join(directory, name, '..'), { recursive: true });
		writeFileSync(join(directory, name), content);
	}
}

function releaseFiles(version: string): Record<string, string> {
	return {
		'action.yml': `name: Test\nruns:\n  using: node24\n  main: dist/index.js\n`,
		'dist/index.js': `// bundle for v${version}\n`,
		'release.json': `{\n  "version": "${version}",\n  "upstream": "${UPSTREAM}"\n}\n`,
	};
}

/** A bare mirror plus the authenticated checkout of it the workflow hands to `publish`. */
class Fixture {
	readonly root = mkdtempSync(join(tmpdir(), 'mirror-test-'));
	readonly bare = join(this.root, 'mirror.git');
	private clones = 0;
	private stages = 0;

	constructor() {
		git(this.root, 'init', '--bare', '--quiet', '--initial-branch=main', this.bare);
		const seed = this.checkout();
		git(seed, 'commit', '--quiet', '--allow-empty', '-m', 'Initial commit');
		git(seed, 'push', '--quiet', 'origin', 'HEAD:main');
	}

	/** What `actions/checkout` leaves behind: a clone whose origin is the mirror and can be pushed to. */
	checkout(): string {
		const dir = join(this.root, `checkout-${this.clones++}`);
		git(this.root, 'clone', '--quiet', this.bare, dir);
		git(dir, 'config', 'user.name', 'Test Bot');
		git(dir, 'config', 'user.email', 'bot@example.com');
		return dir;
	}

	stage(version: string, files = releaseFiles(version)): string {
		const dir = join(this.root, `stage-${this.stages++}`);
		mkdirSync(dir, { recursive: true });
		write(dir, files);
		return dir;
	}

	options(version: string, files = releaseFiles(version)): PublishOptions {
		return {
			repo: this.checkout(),
			stage: this.stage(version, files),
			version,
			upstream: UPSTREAM,
		};
	}

	release(version: string, files = releaseFiles(version)): string {
		return publish(this.options(version, files));
	}

	ref(name: string): string | undefined {
		const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${name}^{commit}`], {
			cwd: this.bare,
			encoding: 'utf8',
		});
		return result.status === 0 ? result.stdout.trim() : undefined;
	}

	refs(): string[] {
		return git(this.bare, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean);
	}

	file(ref: string, path: string): string {
		return git(this.bare, 'show', `${ref}:${path}`);
	}

	dispose(): void {
		rmSync(this.root, { recursive: true, force: true });
	}
}

/** A monorepo root holding one action workspace, for the manifest-driven steps. */
function workspaceRoot(mirror: unknown, version = '1.0.0'): string {
	const root = mkdtempSync(join(tmpdir(), 'mirror-root-'));
	const dir = join(root, 'actions', 'sample');
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, 'package.json'),
		JSON.stringify({ name: '@mawesome/sample-action', version, mirror }),
	);
	write(dir, {
		'action.yml': 'name: Sample\n',
		'src/main.ts': 'export {};\n',
		'dist/index.js': '// bundle\n',
	});
	return root;
}

const SAMPLE = { repo: 'owner/sample-action', files: ['action.yml', 'src', 'dist'] };

describe('version helpers', () => {
	it('parses and compares release versions', () => {
		expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
		expect(() => parseVersion('1.2')).toThrow('Not a release version');
		expect(isNewer(parseVersion('1.10.0'), parseVersion('1.9.9'))).toBe(true);
		expect(isNewer(parseVersion('2.0.0'), parseVersion('2.0.0'))).toBe(false);
	});

	it('builds a subject and an Upstream-Ref footer', () => {
		expect(releaseMessage('1.0.0', UPSTREAM)).toBe(`Release v1.0.0\n\nUpstream-Ref: ${UPSTREAM}\n`);
	});
});

describe('resolveWorkspace', () => {
	it('finds the workspace the release names and reads its mirror configuration', () => {
		expect(resolveWorkspace(workspaceRoot(SAMPLE), '@mawesome/sample-action', '1.0.0')).toEqual({
			dir: join('actions', 'sample'),
			mirror: 'owner/sample-action',
			files: ['action.yml', 'src', 'dist'],
		});
	});

	it('refuses a package no workspace declares', () => {
		expect(() =>
			resolveWorkspace(workspaceRoot(SAMPLE), '@mawesome/other-action', '1.0.0'),
		).toThrow('No workspace under actions/');
	});

	it('refuses a version the workspace is not at on this commit', () => {
		expect(() =>
			resolveWorkspace(workspaceRoot(SAMPLE), '@mawesome/sample-action', '2.0.0'),
		).toThrow('is at 1.0.0 on this commit');
	});

	it('refuses a mirror that is missing, misshapen, or lists nothing', () => {
		const resolveWith = (mirror: unknown): Workspace =>
			resolveWorkspace(workspaceRoot(mirror), '@mawesome/sample-action', '1.0.0');
		expect(() => resolveWith(undefined)).toThrow('does not name a mirror repository');
		expect(() => resolveWith({ repo: 'owner', files: ['action.yml'] })).toThrow(
			'does not name a mirror repository',
		);
		expect(() => resolveWith({ repo: 'owner/sample-action', files: [] })).toThrow(
			'does not list the files to mirror',
		);
	});

	it('refuses a listed path that escapes the workspace', () => {
		const escaping = { repo: 'owner/sample-action', files: ['../../secrets'] };
		expect(() =>
			resolveWorkspace(workspaceRoot(escaping), '@mawesome/sample-action', '1.0.0'),
		).toThrow('outside the workspace');
	});
});

describe('stage', () => {
	const workspace: Workspace = {
		dir: join('actions', 'sample'),
		mirror: 'owner/sample-action',
		files: ['action.yml', 'src', 'dist'],
	};

	it('copies the listed files with the two manifests only the mirror carries', () => {
		const root = workspaceRoot(SAMPLE);
		const out = join(root, 'mirror-stage');
		stage(root, workspace, out, '1.0.0', UPSTREAM);
		expect(readFileSync(join(out, 'action.yml'), 'utf8')).toBe('name: Sample\n');
		expect(readFileSync(join(out, 'src', 'main.ts'), 'utf8')).toBe('export {};\n');
		expect(readFileSync(join(out, 'dist', 'index.js'), 'utf8')).toBe('// bundle\n');
		expect(JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'))).toEqual({
			private: true,
			type: 'module',
		});
		expect(JSON.parse(readFileSync(join(out, 'release.json'), 'utf8'))).toEqual({
			version: '1.0.0',
			upstream: UPSTREAM,
		});
	});

	it('replaces whatever a previous run left in the output directory', () => {
		const root = workspaceRoot(SAMPLE);
		const out = join(root, 'mirror-stage');
		mkdirSync(out, { recursive: true });
		writeFileSync(join(out, 'stale.txt'), 'from an earlier run\n');
		stage(root, workspace, out, '1.0.0', UPSTREAM);
		expect(existsSync(join(out, 'stale.txt'))).toBe(false);
	});

	it('refuses a listed file the workspace does not have', () => {
		const root = workspaceRoot(SAMPLE);
		const missing = { ...workspace, files: [...workspace.files, 'workflow-template.yml'] };
		expect(() => stage(root, missing, join(root, 'mirror-stage'), '1.0.0', UPSTREAM)).toThrow(
			'is missing; it is listed in mirror.files',
		);
	});
});

describe('publish', () => {
	let fixture: Fixture;
	beforeEach(() => {
		fixture = new Fixture();
	});
	afterEach(() => {
		fixture.dispose();
	});

	it('publishes a first release as one commit on main carrying the staged tree', () => {
		const initial = fixture.ref('refs/heads/main');
		const sha = fixture.release('1.0.0');
		expect(fixture.ref('refs/heads/main')).toBe(sha);
		expect(fixture.ref('refs/tags/v1.0.0')).toBe(sha);
		expect(fixture.ref('refs/tags/v1')).toBe(sha);
		expect(git(fixture.bare, 'log', '-1', '--format=%P', sha)).toBe(initial);
		expect(git(fixture.bare, 'log', '-1', '--format=%B', sha).trim()).toBe(
			releaseMessage('1.0.0', UPSTREAM).trim(),
		);
		expect(fixture.file(sha, 'release.json')).toContain('"version": "1.0.0"');
		expect(fixture.file(sha, 'dist/index.js')).toContain('bundle for v1.0.0');
	});

	it('attributes the commit to the configured identity and leaves no extra refs behind', () => {
		const sha = fixture.release('1.0.0');
		expect(git(fixture.bare, 'log', '-1', '--format=%an <%ae>', sha)).toBe(
			'Test Bot <bot@example.com>',
		);
		expect(fixture.refs()).toEqual(['refs/heads/main', 'refs/tags/v1', 'refs/tags/v1.0.0']);
	});

	it('fast-forwards main and moves the major tag on the next release', () => {
		const first = fixture.release('1.0.0');
		const second = fixture.release('1.0.1');
		expect(git(fixture.bare, 'log', '-1', '--format=%P', second)).toBe(first);
		expect(fixture.ref('refs/heads/main')).toBe(second);
		expect(fixture.ref('refs/tags/v1.0.0')).toBe(first);
		expect(fixture.ref('refs/tags/v1.0.1')).toBe(second);
		expect(fixture.ref('refs/tags/v1')).toBe(second);
	});

	it('leaves v1 where it is and creates v2 for a new major', () => {
		const first = fixture.release('1.0.0');
		const second = fixture.release('2.0.0');
		expect(fixture.ref('refs/tags/v1')).toBe(first);
		expect(fixture.ref('refs/tags/v2')).toBe(second);
		expect(fixture.ref('refs/heads/main')).toBe(second);
	});

	it('is a no-op when the same release is published again', () => {
		const sha = fixture.release('1.0.0');
		expect(fixture.release('1.0.0')).toBe(sha);
		expect(fixture.ref('refs/heads/main')).toBe(sha);
		expect(git(fixture.bare, 'rev-list', '--count', 'refs/heads/main')).toBe('2');
	});

	it('retags a release whose commit is on main but whose tag was deleted', () => {
		const sha = fixture.release('1.0.0');
		git(fixture.bare, 'update-ref', '-d', 'refs/tags/v1.0.0');
		git(fixture.bare, 'update-ref', '-d', 'refs/tags/v1');
		expect(fixture.release('1.0.0')).toBe(sha);
		expect(fixture.ref('refs/tags/v1.0.0')).toBe(sha);
		expect(fixture.ref('refs/tags/v1')).toBe(sha);
		expect(fixture.ref('refs/heads/main')).toBe(sha);
	});

	it('refuses a version whose tag exists with other contents', () => {
		fixture.release('1.0.0');
		const other = releaseFiles('1.0.0');
		other['dist/index.js'] = '// tampered\n';
		expect(() => fixture.release('1.0.0', other)).toThrow(
			'already exists on the mirror with other',
		);
		expect(git(fixture.bare, 'rev-list', '--count', 'refs/heads/main')).toBe('2');
	});

	it('refuses to drag the major tag back to a version older than the one it names', () => {
		fixture.release('1.1.0');
		expect(() => fixture.release('1.0.9')).toThrow('which is not older than v1.0.9');
		expect(git(fixture.bare, 'log', '-1', '--format=%s', 'refs/tags/v1')).toBe('Release v1.1.0');
		expect(fixture.ref('refs/tags/v1.0.9')).toBeUndefined();
	});

	it('leaves the major tag alone when rerunning a release it has already moved past', () => {
		const first = fixture.release('1.0.0');
		const second = fixture.release('1.1.0');
		expect(fixture.release('1.0.0')).toBe(first);
		expect(fixture.ref('refs/tags/v1')).toBe(second);
		expect(fixture.ref('refs/heads/main')).toBe(second);
	});

	it('refuses a major tag that is unrelated to the release', () => {
		fixture.release('1.0.0');
		const stray = fixture.checkout();
		git(stray, 'checkout', '--quiet', '--orphan', 'stray');
		git(stray, 'commit', '--quiet', '--allow-empty', '-m', 'Stray');
		git(stray, 'push', '--quiet', '--force', 'origin', 'HEAD:refs/tags/v1');
		expect(() => fixture.release('1.0.1')).toThrow('unrelated to v1.0.1');
	});

	it('moves nothing when main changes under the run', () => {
		const before = fixture.ref('refs/heads/main');
		const options = fixture.options('1.0.0');
		expect(() =>
			publish({
				...options,
				beforePush: () => {
					const racer = fixture.checkout();
					git(racer, 'commit', '--quiet', '--allow-empty', '-m', 'Someone else');
					git(racer, 'push', '--quiet', 'origin', 'HEAD:main');
				},
			}),
		).toThrow('git push failed');
		expect(fixture.ref('refs/heads/main')).not.toBe(before);
		expect(fixture.ref('refs/tags/v1.0.0')).toBeUndefined();
		expect(fixture.ref('refs/tags/v1')).toBeUndefined();
	});

	it('refuses a stage that is missing, a link, empty, or holds a nested repository', () => {
		const options = fixture.options('1.0.0');
		expect(() => publish({ ...options, stage: join(fixture.root, 'absent') })).toThrow(
			'does not exist',
		);
		const link = join(fixture.root, 'stage-link');
		symlinkSync(options.stage, link);
		expect(() => publish({ ...options, stage: link })).toThrow('is a link');
		const empty = join(fixture.root, 'stage-empty');
		mkdirSync(empty, { recursive: true });
		expect(() => publish({ ...options, stage: empty })).toThrow('is empty');
		write(options.stage, { 'vendor/.git/HEAD': 'ref: refs/heads/main\n' });
		expect(() => publish(options)).toThrow('nested repository');
		expect(fixture.ref('refs/tags/v1.0.0')).toBeUndefined();
	});

	it('refuses a checkout that is not a repository', () => {
		const options = fixture.options('1.0.0');
		expect(() => publish({ ...options, repo: fixture.root })).toThrow(
			'not a checkout of the mirror',
		);
	});

	it('refuses a mirror that has no main branch yet', () => {
		git(fixture.bare, 'update-ref', '-d', 'refs/heads/main');
		expect(() => publish(fixture.options('1.0.0'))).toThrow('The mirror has no main branch');
	});

	it('keeps the executable bit the stage carries', () => {
		const options = fixture.options('1.0.0');
		writeFileSync(join(options.stage, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
		const sha = publish(options);
		expect(git(fixture.bare, 'ls-tree', sha, 'run.sh').split(/\s+/)[0]).toBe('100755');
	});
});

describe('command line', () => {
	const script = join(import.meta.dirname, '..', 'scripts', 'deploy-to-mirror.ts');

	it('reports usage and fails on an unknown command', () => {
		const result = spawnSync(process.execPath, [script, 'nope'], { encoding: 'utf8' });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('Usage: deploy-to-mirror.ts <resolve|stage|publish>');
	});

	it('resolves a workspace to GitHub Actions outputs', () => {
		const root = workspaceRoot(SAMPLE);
		const result = spawnSync(
			process.execPath,
			[
				script,
				'resolve',
				'--root',
				root,
				'--package',
				'@mawesome/sample-action',
				'--version',
				'1.0.0',
			],
			{ encoding: 'utf8' },
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('mirror=owner/sample-action');
		expect(result.stdout).toContain('mirror_owner=owner');
		expect(result.stdout).toContain('mirror_repo=sample-action');
		expect(result.stdout).toContain(`dir=${join('actions', 'sample')}`);
	});

	it('fails with the error message when a required argument is missing', () => {
		const result = spawnSync(process.execPath, [script, 'publish', '--repo', 'mirror'], {
			encoding: 'utf8',
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('--repo and --stage are required');
	});
});
