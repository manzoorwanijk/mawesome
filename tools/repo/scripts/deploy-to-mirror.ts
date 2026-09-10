/**
 * Publishes an action workspace to its own mirror repository as one release commit.
 * The mirror arrives as an authenticated checkout, so this builds the commit itself and moves `main`, `vX.Y.Z` and `vX` in one atomic push; nothing else ever writes those refs.
 */
import { execFileSync } from 'node:child_process';
import {
	appendFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export interface Version {
	major: number;
	minor: number;
	patch: number;
}

export interface Workspace {
	/** The workspace directory, relative to the monorepo root. */
	dir: string;
	/** The mirror repository, as `owner/name`. */
	mirror: string;
	/** Paths inside the workspace that are copied to the mirror verbatim. */
	files: string[];
}

export interface PublishOptions {
	/** A checkout of the mirror whose `origin` is the mirror and is authenticated to push. */
	repo: string;
	/** Directory whose contents become the release commit's tree. */
	stage: string;
	/** The version being released, without a `v`. */
	version: string;
	/** The monorepo commit the release was built from. */
	upstream: string;
	/** Test hook run between reading the mirror's refs and pushing, to inject races. */
	beforePush?: (() => void) | undefined;
}

export class MirrorError extends Error {
	override name = 'MirrorError';
}

export function parseVersion(text: string): Version {
	const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
	if (match === null) {
		throw new MirrorError(`Not a release version: "${text}".`);
	}
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function isNewer(candidate: Version, current: Version): boolean {
	if (candidate.major !== current.major) {
		return candidate.major > current.major;
	}
	if (candidate.minor !== current.minor) {
		return candidate.minor > current.minor;
	}
	return candidate.patch > current.patch;
}

/** The commit message every release commit carries; its subject is also how `vX` is read back. */
export function releaseMessage(version: string, upstream: string): string {
	return `Release v${version}\n\nUpstream-Ref: ${upstream}\n`;
}

/** Finds the action workspace a release names and reads the mirror configuration from its manifest. */
export function resolveWorkspace(root: string, name: string, version: string): Workspace {
	const actions = join(root, 'actions');
	for (const entry of readdirSync(actions, { withFileTypes: true })) {
		const manifestPath = join(actions, entry.name, 'package.json');
		if (!entry.isDirectory() || !existsSync(manifestPath)) {
			continue;
		}
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
			name?: string;
			version?: string;
			mirror?: { repo?: string; files?: string[] };
		};
		if (manifest.name !== name) {
			continue;
		}
		if (manifest.version !== version) {
			throw new MirrorError(
				`${name} is at ${String(manifest.version)} on this commit, not ${version}.`,
			);
		}
		const { repo, files } = manifest.mirror ?? {};
		if (repo === undefined || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
			throw new MirrorError(`${name} does not name a mirror repository as owner/name.`);
		}
		if (!Array.isArray(files) || files.length === 0) {
			throw new MirrorError(`${name} does not list the files to mirror.`);
		}
		for (const file of files) {
			if (isAbsolute(file) || normalize(file).startsWith('..')) {
				throw new MirrorError(`${name} lists ${file}, which is outside the workspace.`);
			}
		}
		return { dir: join('actions', entry.name), mirror: repo, files };
	}
	throw new MirrorError(`No workspace under actions/ is named ${name}.`);
}

/** Copies the workspace's mirrored files into an empty directory, with the two manifests only the mirror carries. */
export function stage(
	root: string,
	workspace: Workspace,
	out: string,
	version: string,
	upstream: string,
): void {
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	for (const file of workspace.files) {
		const source = join(root, workspace.dir, file);
		if (!existsSync(source)) {
			throw new MirrorError(
				`${join(workspace.dir, file)} is missing; it is listed in mirror.files.`,
			);
		}
		// verbatimSymlinks, or a relative link is resolved to an absolute runner path on the way in.
		cpSync(source, join(out, file), { recursive: true, verbatimSymlinks: true });
	}
	// The mirror is a checkout rather than a package, but Node still has to read its `src/` as ESM.
	writeFileSync(join(out, 'package.json'), '{\n  "private": true,\n  "type": "module"\n}\n');
	// Records what this mirror commit was built from, so every release changes the tree.
	writeFileSync(
		join(out, 'release.json'),
		`{\n  "version": "${version}",\n  "upstream": "${upstream}"\n}\n`,
	);
}

/** Builds the release commit from the stage and moves `main`, `vX.Y.Z` and `vX` onto it in one atomic push. */
export function publish(options: PublishOptions): string {
	const version = parseVersion(options.version);
	const tag = `refs/tags/v${options.version}`;
	const git = runner(options.repo);

	/* A wildcard refspec, so a mirror without `main` reports that below instead of failing the fetch.
	 * Pruned, so no stale remote-tracking ref can stand in for what the mirror actually has. */
	git([
		'fetch',
		'--quiet',
		'--force',
		'--prune',
		'--prune-tags',
		'--tags',
		'origin',
		'+refs/heads/*:refs/remotes/origin/*',
	]);
	const main = revision(git, 'refs/remotes/origin/main');
	if (main === undefined) {
		throw new MirrorError(
			'The mirror has no main branch; create it by hand with an empty initial commit first.',
		);
	}
	const tree = buildTree(git, options.repo, options.stage, main);
	const released = revision(git, tag);
	let release: string;
	if (released !== undefined) {
		if (!isReleaseCommit(git, released, tree, options)) {
			throw new MirrorError(`v${options.version} already exists on the mirror but is not it.`);
		}
		if (!isAncestor(git, released, main)) {
			throw new MirrorError(
				`v${options.version} exists but the mirror's main does not contain it.`,
			);
		}
		release = released;
	} else if (isReleaseCommit(git, main, tree, options)) {
		// The release commit landed but its tag did not, or was deleted since; retag what is already there.
		release = main;
	} else {
		release = git(
			['commit-tree', tree, '-p', main],
			releaseMessage(options.version, options.upstream),
		);
	}

	const refspecs: string[] = [];
	const flags = ['--atomic'];
	/* Only a commit this run built moves main; a rerun of an older release must never rewind it.
	 * The other two paths reached a commit main already contains. */
	if (release !== main && released === undefined) {
		refspecs.push(`${release}:refs/heads/main`);
		flags.push(`--force-with-lease=refs/heads/main:${main}`);
	}
	if (released === undefined) {
		// Neither forced nor leased: an unforced tag push is itself rejected if the tag appeared meanwhile.
		refspecs.push(`${release}:${tag}`);
	}
	appendMajor(git, options, version, release, main, refspecs, flags);
	if (refspecs.length > 0) {
		options.beforePush?.();
		git(['push', '--quiet', '--no-verify', ...flags, '--', 'origin', ...refspecs]);
	}
	output('release_sha', release);
	return release;
}

/** Adds the `vX` move to the push, or leaves the tag alone when it already points past this release. */
function appendMajor(
	git: Git,
	options: PublishOptions,
	version: Version,
	release: string,
	main: string,
	refspecs: string[],
	flags: string[],
): void {
	const major = `refs/tags/v${version.major}`;
	const tag = advertised(git, major);
	if (tag === undefined) {
		refspecs.push(`${release}:${major}`);
		flags.push(`--force-with-lease=${major}:`);
		return;
	}
	if (tag.commit === release) {
		return;
	}
	if (isAncestor(git, release, tag.commit)) {
		// A rerun of a release that vX has already moved past; the newer release keeps the tag.
		if (!isSupersedingRelease(git, version, tag.commit, main)) {
			throw new MirrorError(
				`v${version.major} points past v${options.version} but is not a newer release of it; fix it by hand.`,
			);
		}
		console.log(`v${version.major} already points past v${options.version}; leaving it.`);
		return;
	}
	if (!isAncestor(git, tag.commit, release)) {
		throw new MirrorError(
			`v${version.major} points at a commit unrelated to v${options.version}; fix it by hand.`,
		);
	}
	const released = releasedVersion(git, tag.commit);
	if (released !== undefined && !isNewer(version, released.version)) {
		throw new MirrorError(
			`v${version.major} already points at v${released.text}, which is not older than v${options.version}.`,
		);
	}
	/* Leased on the advertised value, which for an annotated tag is the tag object rather than its commit.
	 * No `+` on the refspec either: a forced refspec makes git skip the lease, while the lease alone allows the non-fast-forward. */
	refspecs.push(`${release}:${major}`);
	flags.push(`--force-with-lease=${major}:${tag.value}`);
}

/** vX may only sit past a release on a newer, single-parent release of the same major whose own tag points there. */
function isSupersedingRelease(git: Git, version: Version, current: string, main: string): boolean {
	const newer = releasedVersion(git, current);
	if (
		!isAncestor(git, current, main) ||
		newer === undefined ||
		newer.version.major !== version.major ||
		!isNewer(newer.version, version) ||
		parents(git, current).length !== 1
	) {
		return false;
	}
	// The subject alone proves nothing; the newer release's own tag has to point at this commit.
	return revision(git, `refs/tags/v${newer.text}`) === current;
}

/** A commit is a release only if it carries its exact tree, its message, and a single parent. */
function isReleaseCommit(git: Git, sha: string, tree: string, options: PublishOptions): boolean {
	if (git(['rev-parse', `${sha}^{tree}`]) !== tree || parents(git, sha).length !== 1) {
		return false;
	}
	const lines = git(['log', '-1', '--format=%B', sha]).split('\n');
	return (
		lines[0]?.trim() === `Release v${options.version}` &&
		lines.includes(`Upstream-Ref: ${options.upstream}`)
	);
}

function parents(git: Git, sha: string): string[] {
	return git(['log', '-1', '--format=%P', sha]).split(' ').filter(Boolean);
}

type Git = (args: string[], input?: string) => string;

function runner(dir: string): Git {
	if (!existsSync(join(dir, '.git'))) {
		throw new MirrorError(`${dir} is not a checkout of the mirror.`);
	}
	return (args, input) => {
		try {
			return execFileSync('git', args, {
				cwd: dir,
				env: { ...process.env, LC_ALL: 'C' },
				encoding: 'utf8',
				input,
				stdio: ['pipe', 'pipe', 'pipe'],
			}).trim();
		} catch (error) {
			const stderr = String((error as { stderr?: string }).stderr ?? '').trim();
			throw new MirrorError(`git ${String(args[0])} failed: ${stderr}`);
		}
	};
}

/** Replaces the checkout's contents with the stage and returns the tree that describes it. */
function buildTree(git: Git, repo: string, stagePath: string, main: string): string {
	if (!existsSync(stagePath) || !lstatSync(stagePath).isDirectory()) {
		throw new MirrorError(`Stage directory ${stagePath} does not exist or is a link.`);
	}
	rejectNestedRepositories(stagePath, stagePath);
	git(['read-tree', main]);
	for (const entry of readdirSync(repo)) {
		if (entry !== '.git') {
			rmSync(join(repo, entry), { recursive: true, force: true });
		}
	}
	cpSync(stagePath, repo, { recursive: true, verbatimSymlinks: true });
	git(['add', '--all', '--force', '.']);
	const entries = git(['ls-files', '--stage']).split('\n').filter(Boolean);
	if (entries.length === 0) {
		throw new MirrorError(`Stage directory ${stagePath} is empty.`);
	}
	if (entries.some((line) => line.startsWith('160000 '))) {
		throw new MirrorError(`Stage directory ${stagePath} contains a nested repository.`);
	}
	return git(['write-tree']);
}

/** `git add` silently drops anything under a `.git` directory, so the stage has to be checked before it is copied. */
function rejectNestedRepositories(directory: string, root: string): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === '.git') {
			throw new MirrorError(`Stage directory ${root} contains a nested repository.`);
		}
		if (entry.isDirectory()) {
			rejectNestedRepositories(join(directory, entry.name), root);
		}
	}
}

function revision(git: Git, ref: string): string | undefined {
	try {
		return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
	} catch {
		return undefined;
	}
}

/** A ref's value as the mirror advertises it, which a lease compares against, alongside the commit it peels to. */
function advertised(git: Git, ref: string): { value: string; commit: string } | undefined {
	const commit = revision(git, ref);
	return commit === undefined ? undefined : { value: git(['rev-parse', '--verify', ref]), commit };
}

function isAncestor(git: Git, ancestor: string, descendant: string): boolean {
	try {
		git(['merge-base', '--is-ancestor', ancestor, descendant]);
		return true;
	} catch {
		return false;
	}
}

/** The version a release commit's subject names, if it is one, with the subject's own spelling of it. */
function releasedVersion(git: Git, sha: string): { version: Version; text: string } | undefined {
	const match = /^Release v(\d+\.\d+\.\d+)$/.exec(git(['log', '-1', '--format=%s', sha]));
	return match === null
		? undefined
		: { version: parseVersion(match[1] as string), text: match[1] as string };
}

function output(name: string, value: string): void {
	const file = process.env['GITHUB_OUTPUT'];
	if (file !== undefined && file.length > 0) {
		appendFileSync(file, `${name}=${value}\n`);
	}
	console.log(`${name}=${value}`);
}

if (import.meta.main) {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			root: { type: 'string' },
			package: { type: 'string' },
			version: { type: 'string' },
			upstream: { type: 'string' },
			out: { type: 'string' },
			repo: { type: 'string' },
			stage: { type: 'string' },
		},
	});
	const command = positionals[0];
	const root = resolve(values.root ?? process.cwd());
	const name = values.package ?? '';
	const version = values.version ?? '';
	const upstream = values.upstream ?? '';
	try {
		if (command === 'resolve' || command === 'stage') {
			if (name.length === 0 || version.length === 0) {
				throw new MirrorError('--package and --version are required.');
			}
			const workspace = resolveWorkspace(root, name, version);
			if (command === 'resolve') {
				output('dir', workspace.dir);
				output('mirror', workspace.mirror);
				output('mirror_owner', workspace.mirror.slice(0, workspace.mirror.indexOf('/')));
				output('mirror_repo', workspace.mirror.slice(workspace.mirror.indexOf('/') + 1));
			} else {
				if (values.out === undefined || upstream.length === 0) {
					throw new MirrorError('--out and --upstream are required.');
				}
				stage(root, workspace, resolve(values.out), version, upstream);
			}
		} else if (command === 'publish') {
			if (values.repo === undefined || values.stage === undefined) {
				throw new MirrorError('--repo and --stage are required.');
			}
			if (version.length === 0 || upstream.length === 0) {
				throw new MirrorError('--version and --upstream are required.');
			}
			publish({
				// Absolute, because git runs with the checkout as its working directory.
				repo: resolve(values.repo),
				stage: resolve(values.stage),
				version,
				upstream,
			});
		} else {
			throw new MirrorError(
				'Usage: deploy-to-mirror.ts <resolve|stage|publish> [--root <dir>] [--package <name>] [--version <x.y.z>] [--upstream <sha>] [--out <dir>] [--repo <dir>] [--stage <dir>]',
			);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
