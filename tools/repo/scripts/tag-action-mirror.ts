/**
 * Publishes a release of the pr-baseline action to its mirror repository in guarded steps.
 * `prepare` records main and creates the release branch, the deploy action commits the staged tree on it, `promote` verifies that commit and moves the refs, `cleanup` drops the branch.
 */
import { execFileSync } from 'node:child_process';
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export interface Options {
	/** The mirror's clone URL; https on GitHub, file:// in tests. */
	mirror: string;
	/** The version being released, without a `v`. */
	version: string;
	/** The monorepo commit the release was built from. */
	upstream: string;
	/** Directory whose tree the deployed commit must reproduce exactly; unverified when absent. */
	stage?: string | undefined;
	/** Token presented to an https mirror; unused for other URLs. */
	token?: string | undefined;
	/** Where the state between steps lives. */
	state: string;
	/** Scratch directory for a local repository. */
	work?: string | undefined;
	/** The commit the deploy step reported pushing; the branch must still hold it. */
	deployed?: string | undefined;
	/** Test hooks run before the branch creation and around the atomic promotion, to inject failures and races. */
	hooks?: { beforeCreate?(): void; beforePush?(): void; afterPush?(): void } | undefined;
}

export interface State {
	path: 'publish' | 'resume';
	mainSha: string;
	branch: string;
	branchCreated: boolean;
	/** Where this run created the branch. */
	branchSha?: string;
	/** The commit the deploy step left on the branch, recorded before it is verified. */
	deployedSha?: string;
	releaseSha?: string;
}

interface Version {
	major: number;
	minor: number;
	patch: number;
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

/** The commit message the deploy step writes; `promote` and the resume path require it verbatim in the subject and footer. */
export function releaseMessage(version: string, upstream: string): string {
	return `Release v${version}\n\nUpstream-Ref: ${upstream}`;
}

export function messageMatches(message: string, version: string, upstream: string): boolean {
	const lines = message.split('\n');
	return lines[0]?.trim() === `Release v${version}` && lines.includes(`Upstream-Ref: ${upstream}`);
}

/** A git runner bound to a scratch repository with the mirror as its only remote and the token, if any, as a header. */
class Mirror {
	readonly dir: string;
	private readonly options: Options;
	private readonly env: Record<string, string | undefined>;
	/* The credential only reaches the commands that talk to the mirror, never the local ones that read the stage. */
	private readonly remoteEnv: Record<string, string>;
	private readonly secrets: string[];

	constructor(options: Options) {
		this.options = options;
		this.dir = options.work ?? mkdtempSync(join(tmpdir(), 'action-mirror-'));
		const env: Record<string, string | undefined> = { ...process.env, LC_ALL: 'C' };
		for (const name of Object.keys(env)) {
			if (name.toUpperCase().startsWith('GIT_') || env[name] === options.token) {
				delete env[name];
			}
		}
		this.env = env;
		this.remoteEnv = {};
		this.secrets = [];
		const origin = httpsOrigin(options.mirror);
		if (origin !== null && options.token !== undefined && options.token.length > 0) {
			const basic = Buffer.from(`x-access-token:${options.token}`).toString('base64');
			this.remoteEnv = {
				GIT_CONFIG_COUNT: '2',
				GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
				GIT_CONFIG_VALUE_0: '',
				GIT_CONFIG_KEY_1: `http.${origin}/.extraheader`,
				GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
			};
			this.secrets = [options.token, basic];
		}
		this.git(['init', '--quiet']);
	}

	git(args: string[], extraEnv: Record<string, string> = {}, remote = false): string {
		try {
			return execFileSync('git', args, {
				cwd: this.dir,
				env: { ...this.env, ...(remote ? this.remoteEnv : {}), ...extraEnv },
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (error) {
			const stderr = String((error as { stderr?: string }).stderr ?? '').trim();
			throw new MirrorError(`git ${args[0]} failed: ${scrub(stderr, this.secrets)}`);
		}
	}

	/** A command that talks to the mirror: the credential is present and no local hook runs. */
	private remote(args: string[]): string {
		return this.git(args, {}, true);
	}

	/** Advertised OIDs for the given refs, peeled where the remote offers it. */
	refs(...names: string[]): Map<string, string> {
		const listing = this.remote([
			'ls-remote',
			'--',
			this.options.mirror,
			...names,
			...names.map((name) => `${name}^{}`),
		]);
		const map = new Map<string, string>();
		for (const line of listing.split('\n')) {
			const [oid, ref] = line.trim().split(/\s+/);
			if (oid !== undefined && ref !== undefined) {
				map.set(ref, oid);
			}
		}
		return map;
	}

	commitOf(ref: string, map: Map<string, string>): string | undefined {
		return map.get(`${ref}^{}`) ?? map.get(ref);
	}

	fetch(...refs: string[]): void {
		this.remote(['fetch', '--quiet', '--no-tags', '--', this.options.mirror, ...refs]);
	}

	message(sha: string): string {
		return this.git(['log', '-1', '--format=%B', sha]);
	}

	parents(sha: string): string[] {
		return this.git(['log', '-1', '--format=%P', sha]).trim().split(' ').filter(Boolean);
	}

	treeOf(sha: string): string {
		return this.git(['rev-parse', `${sha}^{tree}`]).trim();
	}

	/** The tree id of a directory's contents, built through a private index so nothing else is touched. */
	stagedTree(directory: string): string {
		if (!existsSync(directory) || !lstatSync(directory).isDirectory()) {
			throw new MirrorError(`Stage directory ${directory} does not exist or is a link.`);
		}
		rejectNestedRepositories(directory, directory);
		const index = join(this.dir, 'stage-index');
		this.git(['--work-tree', directory, 'add', '--all', '--force', '.'], {
			GIT_INDEX_FILE: index,
		});
		const entries = this.git(['ls-files', '--stage'], { GIT_INDEX_FILE: index })
			.split('\n')
			.filter((line) => line.length > 0);
		if (entries.length === 0) {
			throw new MirrorError(`Stage directory ${directory} is empty.`);
		}
		if (entries.some((line) => line.startsWith('160000 '))) {
			throw new MirrorError(`Stage directory ${directory} contains a nested repository.`);
		}
		return this.git(['write-tree'], { GIT_INDEX_FILE: index }).trim();
	}

	isAncestor(ancestor: string, descendant: string): boolean {
		try {
			this.git(['merge-base', '--is-ancestor', ancestor, descendant]);
			return true;
		} catch {
			return false;
		}
	}

	push(refspecs: string[], flags: string[] = []): void {
		this.remote([
			'push',
			'--quiet',
			'--no-verify',
			...flags,
			'--',
			this.options.mirror,
			...refspecs,
		]);
	}

	/** Creates a ref that must not exist yet; a ref that already holds the value is not a creation and is someone else's. */
	create(ref: string, sha: string): void {
		const report = this.remote([
			'push',
			'--porcelain',
			'--no-verify',
			`--force-with-lease=${ref}:`,
			'--',
			this.options.mirror,
			`${sha}:${ref}`,
		]);
		if (!report.split('\n').some((line) => line.startsWith('*\t'))) {
			throw new MirrorError(`${ref} was created by another run meanwhile.`);
		}
	}

	deleteBranch(branch: string, expected: string): void {
		this.push([`:${branch}`], [`--force-with-lease=${branch}:${expected}`]);
	}
}

/** A `.git` inside the stage would become a gitlink instead of files; git only warns about it. */
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

function httpsOrigin(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:' ? `https://${parsed.host}` : null;
	} catch {
		return null;
	}
}

function scrub(text: string, secrets: string[]): string {
	return secrets.reduce((result, secret) => result.replaceAll(secret, '***'), text);
}

function output(name: string, value: string): void {
	const file = process.env['GITHUB_OUTPUT'];
	if (file !== undefined && file.length > 0) {
		appendFileSync(file, `${name}=${value}\n`);
	}
	console.log(`${name}=${value}`);
}

function saveState(options: Options, state: State): void {
	writeFileSync(options.state, JSON.stringify(state, null, 2));
}

function loadState(options: Options): State {
	return JSON.parse(readFileSync(options.state, 'utf8')) as State;
}

/** Decides between the publish and resume paths, records main, and creates the temporary branch. */
export function prepare(options: Options): State {
	const mirror = new Mirror(options);
	const version = parseVersion(options.version);
	const tag = `refs/tags/v${options.version}`;
	const major = `refs/tags/v${version.major}`;
	const branch = `refs/heads/release/v${options.version}`;
	const refs = mirror.refs('refs/heads/main', tag, major, branch);
	const main = refs.get('refs/heads/main');
	if (main === undefined) {
		throw new MirrorError(
			'The mirror has no main branch; create it by hand with an empty initial commit first.',
		);
	}
	const leftover = refs.get(branch);
	const released = mirror.commitOf(tag, refs);
	if (released !== undefined) {
		// Resume path: the release commit exists; only the major tag may still need reconciling.
		mirror.fetch(released, main);
		if (
			!messageMatches(mirror.message(released), options.version, options.upstream) ||
			mirror.parents(released).length !== 1
		) {
			throw new MirrorError(`Tag v${options.version} exists but its commit is not this release.`);
		}
		if (!mirror.isAncestor(released, main)) {
			throw new MirrorError(`Tag v${options.version} exists but main does not contain it.`);
		}
		reconcileMajor(mirror, options, version, released, refs);
		if (leftover === released) {
			// A run that died after promoting left its branch behind; it is exactly the release, so drop it.
			mirror.deleteBranch(branch, leftover);
		}
		const state: State = {
			path: 'resume',
			mainSha: main,
			branch,
			branchCreated: false,
			releaseSha: released,
		};
		saveState(options, state);
		output('path', 'resume');
		output('deploy', 'false');
		return state;
	}
	const majorSha = mirror.commitOf(major, refs);
	if (majorSha !== undefined) {
		mirror.fetch(majorSha);
		const current = releasedVersion(mirror, majorSha);
		if (current !== undefined && !isNewer(version, current.version)) {
			throw new MirrorError(
				`v${version.major} already points at v${current.text}, which is not older than v${options.version}.`,
			);
		}
	}
	if (leftover !== undefined) {
		throw new MirrorError(
			`${branch} exists on the mirror; a previous run is in flight or died, delete it by hand once it is not.`,
		);
	}
	const state: State = { path: 'publish', mainSha: main, branch, branchCreated: false };
	saveState(options, state);
	mirror.fetch(main);
	options.hooks?.beforeCreate?.();
	// Created only if absent, so a concurrent run cannot both claim it.
	mirror.create(branch, main);
	// Ownership is recorded only now: a branch this push did not create is never this run's to delete.
	state.branchCreated = true;
	state.branchSha = main;
	saveState(options, state);
	output('path', 'publish');
	output('deploy', 'true');
	output('main_sha', main);
	output('target_branch', branch.replace('refs/heads/', ''));
	return state;
}

/** Verifies the deployed commit on the temporary branch and moves main and both tags in one atomic push. */
export function promote(options: Options): State {
	const state = loadState(options);
	if (state.path !== 'publish') {
		return state;
	}
	const mirror = new Mirror(options);
	const version = parseVersion(options.version);
	const tag = `refs/tags/v${options.version}`;
	const major = `refs/tags/v${version.major}`;
	const refs = mirror.refs(state.branch, tag, 'refs/heads/main', major);
	const head = refs.get(state.branch);
	if (head === undefined) {
		throw new MirrorError(`${state.branch} vanished before promotion.`);
	}
	if (state.deployedSha !== undefined && head !== state.deployedSha) {
		throw new MirrorError(`${state.branch} moved since this run deployed; fix it by hand.`);
	}
	if (state.deployedSha === undefined) {
		/* The deploy step runs outside this script, so the branch must still hold the commit it reported.
		 * It is recorded before the checks below, so cleanup may delete it when one of them fails. */
		if (options.deployed === undefined) {
			throw new MirrorError('--deployed is required: pass the commit the deploy step reported.');
		}
		if (head !== options.deployed) {
			throw new MirrorError(`${state.branch} does not hold the commit the deploy step reported.`);
		}
		state.deployedSha = head;
		saveState(options, state);
	}
	if (refs.has(tag)) {
		throw new MirrorError(
			`Tag v${options.version} appeared while this run was deploying; rerun to resume.`,
		);
	}
	mirror.fetch(head, state.mainSha);
	if (!messageMatches(mirror.message(head), options.version, options.upstream)) {
		throw new MirrorError(
			"The deployed commit does not carry this release's subject and Upstream-Ref footer.",
		);
	}
	const parents = mirror.parents(head);
	if (parents.length !== 1 || parents[0] !== state.mainSha) {
		// A merge commit would carry foreign history onto main even with the right tree, so only a single parent is accepted.
		throw new MirrorError(
			'The deployed commit is not a single commit on top of the main recorded before deploying.',
		);
	}
	if (options.stage !== undefined && mirror.treeOf(head) !== mirror.stagedTree(options.stage)) {
		throw new MirrorError('The deployed commit does not reproduce the staged tree exactly.');
	}
	const refspecs = [`${head}:refs/heads/main`, `${head}:${tag}`];
	const flags = ['--atomic', `--force-with-lease=refs/heads/main:${state.mainSha}`];
	const currentMajor = mirror.commitOf(major, refs);
	if (currentMajor === undefined) {
		refspecs.push(`${head}:${major}`);
		flags.push(`--force-with-lease=${major}:`);
	} else {
		mirror.fetch(currentMajor);
		if (!mirror.isAncestor(currentMajor, head)) {
			throw new MirrorError(
				`v${version.major} points at a commit that is not an ancestor of the release; fix it by hand.`,
			);
		}
		// No `+` on the refspec: a forced refspec makes git skip the lease, while the lease alone allows the non-fast-forward.
		refspecs.push(`${head}:${major}`);
		flags.push(`--force-with-lease=${major}:${refs.get(major) as string}`);
	}
	options.hooks?.beforePush?.();
	// One atomic push: main, the version tag and the major tag move together, or nothing does.
	mirror.push(refspecs, flags);
	options.hooks?.afterPush?.();
	state.releaseSha = head;
	saveState(options, state);
	output('release_sha', head);
	return state;
}

/** Resume path only: moves the major tag forward with a lease, creating it when absent, refusing anything but a fast-forward. */
function reconcileMajor(
	mirror: Mirror,
	options: Options,
	version: Version,
	release: string,
	refs: Map<string, string>,
): void {
	const major = `refs/tags/v${version.major}`;
	const current = mirror.commitOf(major, refs);
	if (current === release) {
		return;
	}
	if (current === undefined) {
		mirror.push([`${release}:${major}`], [`--force-with-lease=${major}:`]);
		return;
	}
	mirror.fetch(current, release);
	if (isSupersedingRelease(mirror, version, release, current, refs)) {
		return;
	}
	if (!mirror.isAncestor(current, release)) {
		throw new MirrorError(
			`v${version.major} points at a commit that is not an ancestor of v${options.version}; fix it by hand.`,
		);
	}
	mirror.push(
		[`${release}:${major}`],
		[`--force-with-lease=${major}:${refs.get(major) as string}`],
	);
}

/** The version a release commit's subject names, if it is one, with the subject's own spelling of it. */
function releasedVersion(
	mirror: Mirror,
	sha: string,
): { version: Version; text: string } | undefined {
	const subject = mirror.message(sha).split('\n')[0] ?? '';
	const match = /^Release v(\d+\.\d+\.\d+)$/.exec(subject.trim());
	return match === null
		? undefined
		: { version: parseVersion(match[1] as string), text: match[1] as string };
}

/* A rerun of a superseded release finds the major tag already past it; that is fine only when the tag sits on main at a newer release of the same major. */
function isSupersedingRelease(
	mirror: Mirror,
	version: Version,
	release: string,
	current: string,
	refs: Map<string, string>,
): boolean {
	if (!mirror.isAncestor(release, current)) {
		return false;
	}
	const main = refs.get('refs/heads/main');
	if (main === undefined || !mirror.isAncestor(current, main)) {
		return false;
	}
	const newer = releasedVersion(mirror, current);
	if (
		newer === undefined ||
		newer.version.major !== version.major ||
		!isNewer(newer.version, version) ||
		mirror.parents(current).length !== 1
	) {
		return false;
	}
	// The subject alone proves nothing; the newer release's own tag has to point at this commit.
	const newerTag = `refs/tags/v${newer.text}`;
	return mirror.commitOf(newerTag, mirror.refs(newerTag)) === current;
}

/** Deletes the temporary branch, only when this run created it and it points at a commit this run recorded. */
export function cleanup(options: Options): void {
	let state: State;
	try {
		state = loadState(options);
	} catch {
		return;
	}
	if (!state.branchCreated) {
		return;
	}
	const mirror = new Mirror(options);
	const current = mirror.refs(state.branch).get(state.branch);
	if (current === undefined) {
		return;
	}
	if (![state.branchSha, state.deployedSha, state.releaseSha, options.deployed].includes(current)) {
		console.warn(`${state.branch} moved since this run; leaving it alone.`);
		return;
	}
	mirror.deleteBranch(state.branch, current);
}

if (import.meta.main) {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			mirror: { type: 'string' },
			version: { type: 'string' },
			upstream: { type: 'string' },
			stage: { type: 'string' },
			state: { type: 'string' },
			deployed: { type: 'string' },
		},
	});
	const command = positionals[0];
	const options: Options = {
		mirror: values.mirror ?? '',
		version: values.version ?? '',
		upstream: values.upstream ?? '',
		// Absolute, because git runs in a scratch repository elsewhere and resolves relative paths from there.
		stage: values.stage === undefined ? undefined : resolve(values.stage),
		state: resolve(
			values.state ?? join(process.env['RUNNER_TEMP'] ?? tmpdir(), 'action-mirror-state.json'),
		),
		token: process.env['MIRROR_TOKEN'],
		deployed: values.deployed === undefined || values.deployed === '' ? undefined : values.deployed,
	};
	try {
		if (
			options.mirror.length === 0 ||
			options.version.length === 0 ||
			options.upstream.length === 0
		) {
			throw new MirrorError('--mirror, --version and --upstream are required.');
		}
		if (command === 'prepare') {
			prepare(options);
		} else if (command === 'promote') {
			promote(options);
		} else if (command === 'cleanup') {
			cleanup(options);
		} else {
			throw new MirrorError(
				'Usage: tag-action-mirror.ts <prepare|promote|cleanup> --mirror <url> --version <x.y.z> --upstream <sha> [--stage <dir>] [--deployed <sha>]',
			);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
