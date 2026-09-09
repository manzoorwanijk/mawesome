import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
/** Refspecs per fetch or ls-remote invocation, and the characters they may add up to: well under Windows' 8 KiB line limit. */
const REF_BATCH = 200;
const BATCH_CHARS = 6000;
/** Fetch flags shared by every fetch: no trees or blobs, no tag following, no FETCH_HEAD churn. */
const FETCH_FLAGS = ['fetch', '--quiet', '--no-tags', '--filter=tree:0', '--no-write-fetch-head'];

/** Strips `user:password@` from every URL in a string, so no credential ever reaches an error message. */
export function redactUserinfo(text: string): string {
	return text.replaceAll(/(\w+:\/\/)[^/@\s]+@/g, '$1***@');
}

/** A git command failed; `stderr` carries git's own explanation. */
export class GitError extends Error {
	override name = 'GitError';
	readonly args: string[];
	readonly stderr: string;
	readonly code: number | undefined;

	constructor(args: string[], stderr: string, code: number | undefined) {
		super(
			`git ${args.map(redactUserinfo).join(' ')} failed${code === undefined ? '' : ` (${code})`}: ${redactUserinfo(stderr.trim())}`,
		);
		this.args = args.map(redactUserinfo);
		this.stderr = redactUserinfo(stderr);
		this.code = code;
	}
}

/** A local repository the git adapter works in, with one remote that serves the GitHub repository. */
export interface GitRepo {
	readonly dir: string;
	readonly remote: string;
	/** The remote's URL as read once at open time; network commands address it directly, never the nickname. */
	readonly url: string | null;
	/** Runs git in the repository and returns stdout; a nonzero exit throws `GitError`. */
	git(args: string[], extraEnv?: Record<string, string>): Promise<string>;
}

interface ExecFailure {
	stderr?: string | Buffer;
	code?: number | string;
}

export interface OpenRepoOptions {
	remote?: string;
	/** Forbid the lazy object fetches a partial clone performs on its own, so nothing reaches the network. */
	offline?: boolean;
	/** Token presented to the http(s) remote on every fetch, since a checkout may keep no credentials. */
	token?: string;
	/** The only git server the token may be sent to. */
	serverUrl?: string;
	/** The one transport git may use, derived from the validated remote URL; set once the URL is known. */
	allowProtocol?: string;
}

/** The git transport a remote URL uses, as `GIT_ALLOW_PROTOCOL` names it; null when unrecognized. */
export function transportOf(url: string): string | null {
	const origin = httpOrigin(url);
	if (origin !== null) {
		return origin.startsWith('https:') ? 'https' : 'http';
	}
	// A UNC path, or a `file:` URL with a host or a `//server/share` path, reaches a file server over the network.
	if (/^(\\\\|\/\/)[^\\/]/.test(url) || /^file:\/\/[^/]/i.test(url) || isUncFileUrl(url)) {
		return 'unc';
	}
	if (url.startsWith('file://') || /^([a-z]:)?[\\/]/i.test(url) || /^\.\.?[\\/]/.test(url)) {
		return 'file';
	}
	// `ssh://` and the scp-like `[user@]host:path` form, where the user may come from ssh configuration.
	if (url.startsWith('ssh://') || /^(?:[^/:@]+@)?[^/:@]+:(?![/:])/.test(url)) {
		return 'ssh';
	}
	// Anything left without a scheme or a helper is a plain relative path (git reads `a/b:c` as a path too).
	if (url.length > 0 && !/::|:\/\//.test(url)) {
		return 'file';
	}
	return null;
}

/**
 * Whether a `file:` URL names a `//server/share` reference: `file:///path` is local (three slashes),
 * `file://host/path` has a host, and four or more slashes put a UNC path where the local path would be.
 */
function isUncFileUrl(url: string): boolean {
	if (!/^file:/i.test(url)) {
		return false;
	}
	let rest = url.slice('file:'.length);
	try {
		rest = decodeURIComponent(rest);
	} catch {
		// An undecodable URL is treated as a network reference rather than trusted as a local path.
		return true;
	}
	// Decoded first, so an escaped backslash counts as the separator it becomes.
	const slashes = /^\/*/.exec(rest.replaceAll('\\', '/'))?.[0].length ?? 0;
	return slashes >= 4;
}

/** A config entry handed to git through `GIT_CONFIG_*`, which keeps values out of the command line. */
type ConfigEntry = [key: string, value: string];

/*
 * Settings for every git the adapter runs: no hooks, no credential helpers, no submodule recursion,
 * no background maintenance and no prompts, so nothing the clone configures can run with the token nearby.
 */
const HARDENING: ConfigEntry[] = [
	['core.hooksPath', '/dev/null'],
	// A signed push would run a signing program with the token in its environment.
	['push.gpgSign', 'false'],
	['credential.helper', ''],
	['fetch.recurseSubmodules', 'false'],
	['maintenance.auto', 'false'],
	['gc.auto', '0'],
	['credential.interactive', 'false'],
];

/**
 * The environment every git subprocess starts from: English messages, replacement objects and grafts
 * ignored, optional offline mode, the hardening entries, and no copy of the token anywhere.
 */
export function gitBaseEnv(
	inherited: Record<string, string | undefined>,
	options: OpenRepoOptions,
	extraConfig: ConfigEntry[] = [],
): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	for (const [name, value] of Object.entries(inherited)) {
		// No inherited `GIT_*` variable survives, whatever its case: Windows reads environment names case-insensitively.
		if (name.toUpperCase().startsWith('GIT_')) {
			continue;
		}
		if (options.token === undefined || value !== options.token) {
			env[name] = value;
		}
	}
	env['LC_ALL'] = 'C';
	env['LANG'] = 'C';
	env['GIT_NO_REPLACE_OBJECTS'] = '1';
	env['GIT_TERMINAL_PROMPT'] = '0';
	env['GIT_TRACE_REDACT'] = '1';
	env['GIT_ASKPASS'] = '';
	env['SSH_ASKPASS'] = '';
	// Nothing git does afterwards may switch transports, whatever a rewrite or a helper URL would ask for.
	env['GIT_ALLOW_PROTOCOL'] = options.allowProtocol ?? '';
	if (options.offline) {
		env['GIT_NO_LAZY_FETCH'] = '1';
	}
	const entries = [...HARDENING, ...extraConfig];
	env['GIT_CONFIG_COUNT'] = String(entries.length);
	entries.forEach(([key, value], index) => {
		env[`GIT_CONFIG_KEY_${index}`] = key;
		env[`GIT_CONFIG_VALUE_${index}`] = value;
	});
	return env;
}

/**
 * Config entries that authenticate git against the permitted http(s) server through an `extraheader`.
 * The header is scoped to that origin and any inherited header for it is cleared first; a remote on any
 * other host or scheme gets nothing.
 */
export function gitAuthConfig(
	remoteUrl: string,
	token: string | undefined,
	serverUrl: string | undefined,
): ConfigEntry[] {
	const origin = httpOrigin(remoteUrl);
	const server = serverUrl === undefined ? undefined : httpOrigin(serverUrl);
	// The credential travels over https only; a plaintext origin gets nothing, whatever the server setting.
	if (
		origin === null ||
		!origin.startsWith('https:') ||
		server === undefined ||
		origin !== server
	) {
		return [];
	}
	if (token === undefined) {
		return [];
	}
	return [
		[`http.${origin}/.extraheader`, ''],
		[`http.${origin}/.extraheader`, `AUTHORIZATION: basic ${basicCredential(token)}`],
	];
}

/** Removes the token and its encoded header form from text git printed, so neither reaches an error message. */
export function scrubSecrets(text: string, token: string | undefined): string {
	if (token === undefined || token.length === 0) {
		return text;
	}
	// The encoded form first: a short token could occur inside it and break the match once replaced.
	return text.replaceAll(basicCredential(token), '***').replaceAll(token, '***');
}

function basicCredential(token: string): string {
	return Buffer.from(`x-access-token:${token}`).toString('base64');
}

/** The lowercased `scheme://host[:port]` of an http(s) URL; null for anything else. */
function httpOrigin(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
			return null;
		}
		return `${parsed.protocol}//${parsed.host}`.toLowerCase();
	} catch {
		return null;
	}
}

/** Opens the repository containing `dir`; null when `dir` is not inside a git work tree or bare repository. */
export async function openRepo(
	dir: string | undefined,
	options: OpenRepoOptions = {},
): Promise<GitRepo | null> {
	const remote = options.remote ?? 'origin';
	let env = gitBaseEnv(process.env, options);
	const cwd = dir ?? process.cwd();
	let top: string;
	try {
		const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { cwd, env });
		top = stdout.trim();
	} catch {
		return null;
	}
	if (top.length === 0) {
		return null;
	}
	const scrub = (text: string): string => scrubSecrets(text, options.token);
	const url = await rawRemoteUrl(top, remote, env);
	if (url !== null) {
		// A UNC remote names no git protocol and is never fetched from online; offline it needs none.
		const transport = transportOf(url) === 'unc' ? '' : (transportOf(url) ?? '');
		env = gitBaseEnv(
			process.env,
			{ ...options, allowProtocol: transport },
			options.offline ? [] : gitAuthConfig(url, options.token, options.serverUrl),
		);
	}
	return {
		dir: top,
		remote,
		url,
		async git(args, extraEnv = {}) {
			try {
				const { stdout } = await run('git', args, {
					cwd: top,
					env: { ...env, ...extraEnv },
					maxBuffer: 256 * 1024 * 1024,
				});
				return stdout;
			} catch (error) {
				const failure = error as ExecFailure;
				const code = typeof failure.code === 'number' ? failure.code : undefined;
				throw new GitError(args.map(scrub), scrub(String(failure.stderr ?? '')), code);
			}
		},
	};
}

/**
 * The remote's single configured fetch URL, unrewritten.
 * A rewrite rule (`url.*.insteadOf`) could turn an accepted URL into a helper at fetch time, so any rule disqualifies the clone.
 */
async function rawRemoteUrl(
	top: string,
	remote: string,
	env: Record<string, string | undefined>,
): Promise<string | null> {
	let urls: string[];
	try {
		// NUL-delimited so an empty second value still counts as a second value.
		const { stdout } = await run('git', ['config', '-z', '--get-all', `remote.${remote}.url`], {
			cwd: top,
			env,
		});
		urls = stdout.split('\0').slice(0, -1);
	} catch {
		return null;
	}
	if (urls.length !== 1 || (urls[0] as string).length === 0) {
		return null;
	}
	try {
		await run('git', ['config', '--get-regexp', '^url\\..*\\.(push)?insteadof$'], {
			cwd: top,
			env,
		});
		return null;
	} catch (error) {
		const failure = error as ExecFailure;
		if (failure.code !== 1) {
			return null;
		}
	}
	/*
	 * Clone-controlled settings that could steer the authenticated request elsewhere or run a program during it:
	 * `http.*` (a proxy, TLS verification, a CA, name overrides), the promisor's own proxy, and the alternate
	 * refs command. Includes are honored, and only the local and worktree scopes count, since those live in the
	 * clone; persisted `extraheader` entries are tolerated.
	 */
	try {
		const { stdout } = await run(
			'git',
			[
				'config',
				'--show-scope',
				'--name-only',
				'--get-regexp',
				'^(http\\..*|remote\\..*|core\\..*|credential\\..*|ssh\\..*|protocol\\..*|url\\..*|fetch\\.bundleuri|bundle\\..*)$',
			],
			{ cwd: top, env },
		);
		const url = urls[0] as string;
		const suspicious = stdout.split('\n').filter((line) => {
			const [scope, name] = line.split('\t');
			if ((scope !== 'local' && scope !== 'worktree') || name === undefined) {
				return false;
			}
			return isSuspiciousSetting(name, url);
		});
		return suspicious.length === 0 ? url : null;
	} catch (error) {
		const failure = error as ExecFailure;
		return failure.code === 1 ? (urls[0] as string) : null;
	}
}

/**
 * Whether a clone-scoped setting could steer or observe an authenticated fetch.
 * A remote named exactly like the URL is consulted by git when that URL is fetched, so only the entries git
 * writes itself after a fetch by URL (promisor, partial clone filter) are tolerated on it.
 */
export function isSuspiciousSetting(name: string, url: string): boolean {
	const lower = name.toLowerCase();
	if (lower.startsWith('http.')) {
		// Only an origin-scoped persisted header is harmless: a longer URL match would outrank the run's token.
		return !/^http\.https?:\/\/[^/]+\/?\.extraheader$/.test(lower);
	}
	if (
		/^core\.(alternaterefscommand|sshcommand|gitproxy|askpass|hookspath|fsmonitor|pager|editor)$/.test(
			lower,
		)
	) {
		return true;
	}
	// A bundle URI is a second place git downloads objects from; only the validated remote may be one.
	if (/^(credential|ssh|protocol|url|bundle)\./.test(lower) || lower === 'fetch.bundleuri') {
		return true;
	}
	if (lower.startsWith('remote.')) {
		if (/\.(proxy|proxyauthmethod|uploadpack|receivepack|vcs)$/.test(lower)) {
			return true;
		}
		const prefix = `remote.${url.toLowerCase()}.`;
		return lower.startsWith(prefix) && !/\.(promisor|partialclonefilter)$/.test(lower);
	}
	return false;
}

/** Whether the repository's remote serves `owner/name`, by URL, so a stray clone is never used for another repo. */
export async function remoteServes(
	repo: GitRepo,
	repoName: string,
	serverUrl: string,
	options: { offline?: boolean } = {},
): Promise<boolean> {
	if (repo.url === null || !remoteUrlServes(repo.url, repoName, serverUrl, options)) {
		return false;
	}
	// A `remote.<name>.vcs` setting tells git to run a helper program for this remote; never adopt that.
	try {
		await repo.git(['config', '--get', `remote.${repo.remote}.vcs`]);
		return false;
	} catch (error) {
		return error instanceof GitError && error.code === 1;
	}
}

/**
 * Whether every promisor remote of a partial clone is the remote the adapter validated.
 * A lazy object fetch contacts promisor remotes on its own, so a second one could run any helper.
 */
export async function promisorsAreValidated(repo: GitRepo): Promise<boolean> {
	// Fetching by URL makes git record that URL as a promisor "remote" of its own; that one is ours too.
	const allowed = new Set([repo.remote, ...(repo.url === null ? [] : [repo.url])]);
	const read = async (args: string[]): Promise<string> => {
		try {
			return await repo.git(args);
		} catch (error) {
			if (error instanceof GitError && error.code === 1) {
				return '';
			}
			throw error;
		}
	};
	// Git accepts every boolean spelling; `--type=bool` canonicalizes them to `true` or `false`.
	const promisors = await read([
		'config',
		'--type=bool',
		'--get-regexp',
		'^remote\\..*\\.promisor$',
	]);
	for (const line of promisors.split('\n')) {
		const match = /^remote\.(.+)\.promisor (true|false)$/.exec(line.trim());
		if (match !== null && match[2] === 'true' && !allowed.has(match[1] as string)) {
			return false;
		}
	}
	// A remote with a partial clone filter is a promisor whatever its `promisor` flag says.
	const filters = await read([
		'config',
		'--name-only',
		'--get-regexp',
		'^remote\\..*\\.partialclonefilter$',
	]);
	for (const line of filters.split('\n')) {
		const match = /^remote\.(.+)\.partialclonefilter$/.exec(line.trim());
		if (match !== null && !allowed.has(match[1] as string)) {
			return false;
		}
	}
	const partial = (await read(['config', '--get', 'extensions.partialclone'])).trim();
	return partial === '' || allowed.has(partial);
}

/** Whether the repository has a grafts file, which rewrites ancestry locally and cannot be trusted. */
export async function hasGrafts(repo: GitRepo): Promise<boolean> {
	const common = (await repo.git(['rev-parse', '--git-common-dir'])).trim();
	return existsSync(join(resolve(repo.dir, common), 'info', 'grafts'));
}

/**
 * Whether a remote URL names exactly `owner/name`.
 * An http(s) remote must also live on the permitted server, since that is the only host the token goes to.
 */
export function remoteUrlServes(
	url: string,
	repoName: string,
	serverUrl: string,
	options: { offline?: boolean } = {},
): boolean {
	const wanted = repoName.toLowerCase();
	// A `<helper>::<address>` URL runs a program of the clone's choosing, and an option-looking value is no URL.
	if (/^[^:/[]*::/.test(url) || url.startsWith('-') || transportOf(url) === null) {
		return false;
	}
	const origin = httpOrigin(url);
	if (origin !== null) {
		// A credential in the URL would travel on every command line; the token has its own scoped channel.
		const parsed = new URL(url);
		// A bare `?` or `#` parses to an empty component yet still changes the request git builds.
		if (parsed.username !== '' || parsed.password !== '' || /[?#]/.test(url)) {
			return false;
		}
		// Offline nothing is sent anywhere, so the scheme may differ from the server's; online it may not.
		const server = httpOrigin(serverUrl);
		const sameHost =
			server !== null && parsed.host.toLowerCase() === new URL(server).host.toLowerCase();
		if (options.offline ? !sameHost : origin !== server) {
			return false;
		}
		const path = new URL(url).pathname
			.replace(/\.git$/, '')
			.replace(/\/+$/, '')
			.toLowerCase();
		return path === `/${wanted}`;
	}
	const normalized = url
		.replaceAll('\\', '/')
		.replace(/\.git$/, '')
		.replace(/\/+$/, '')
		.toLowerCase();
	return normalized.endsWith(`/${wanted}`) || normalized.endsWith(`:${wanted}`);
}

/** Whether history was cut off; a shallow clone cannot answer ancestry reliably. */
export async function isShallow(repo: GitRepo): Promise<boolean> {
	return (await repo.git(['rev-parse', '--is-shallow-repository'])).trim() === 'true';
}

export async function hasCommit(repo: GitRepo, sha: string): Promise<boolean> {
	try {
		// A presence probe must not turn into a lazy fetch; the batched fetch follows when needed.
		await repo.git(['cat-file', '-e', `${sha}^{commit}`], { GIT_NO_LAZY_FETCH: '1' });
		return true;
	} catch {
		return false;
	}
}

/** Resolves a ref to a commit SHA; null when it does not exist locally. */
export async function revParse(repo: GitRepo, ref: string): Promise<string | null> {
	let exists: boolean;
	try {
		await repo.git(['rev-parse', '--verify', '--quiet', ref]);
		exists = true;
	} catch (error) {
		if (error instanceof GitError && error.code === 1) {
			exists = false;
		} else {
			throw error;
		}
	}
	if (!exists) {
		return null;
	}
	// The ref exists, so failing to peel it to a commit is a real problem, never an absence.
	let sha: string;
	try {
		sha = (await repo.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim();
	} catch (error) {
		const detail = error instanceof GitError ? error.stderr.trim() : String(error);
		throw new GitError(['rev-parse', ref], `${ref} does not resolve to a commit: ${detail}`, 128);
	}
	if (!/^[0-9a-f]{40}$/.test(sha)) {
		throw new GitError(['rev-parse', ref], `${ref} does not resolve to a commit`, 128);
	}
	return sha;
}

/** The first git version whose `GIT_NO_LAZY_FETCH` stops a partial clone from fetching objects on its own. */
export const MIN_OFFLINE_GIT = '2.45.0';

/** Whether `git --version` output names a git at least `MIN_OFFLINE_GIT`. */
export function supportsNoLazyFetch(versionOutput: string): boolean {
	const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(versionOutput);
	if (match === null) {
		return false;
	}
	const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
	const [needMajor, needMinor, needPatch] = MIN_OFFLINE_GIT.split('.').map(Number) as [
		number,
		number,
		number,
	];
	return (
		major > needMajor ||
		(major === needMajor && (minor > needMinor || (minor === needMinor && patch >= needPatch)))
	);
}

export async function gitVersion(repo: GitRepo): Promise<string> {
	return (await repo.git(['--version'])).trim();
}

/**
 * Asks the remote for the current OID of each ref without fetching; absent refs are missing from the map.
 * An annotated tag also yields its peeled commit under `<ref>^{}`.
 */
export async function lsRemote(repo: GitRepo, refs: string[]): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	for (const batch of chunks(refs)) {
		const output = await repo.git(['ls-remote', '--', repo.url ?? repo.remote, ...batch]);
		for (const line of output.split('\n')) {
			const [oid, ref] = line.trim().split(/\s+/);
			if (oid !== undefined && ref !== undefined) {
				result.set(ref, oid);
			}
		}
	}
	return result;
}

/** Fetches refspecs treelessly, in batches. */
export async function fetchRefs(repo: GitRepo, refspecs: string[]): Promise<void> {
	for (const batch of chunks(refspecs)) {
		await repo.git([...FETCH_FLAGS, '--', repo.url ?? repo.remote, ...batch]);
	}
}

/** Fetches the commits that are not present locally, by SHA, treelessly. */
export async function fetchMissingCommits(repo: GitRepo, shas: Iterable<string>): Promise<void> {
	const missing: string[] = [];
	for (const sha of new Set(shas)) {
		if (!(await hasCommit(repo, sha))) {
			missing.push(sha);
		}
	}
	if (missing.length > 0) {
		await fetchRefs(repo, missing);
	}
}

/** `git merge-base --is-ancestor`: exit 0 is yes, exit 1 is no, anything else is an error. */
export async function isAncestor(
	repo: GitRepo,
	ancestor: string,
	descendant: string,
): Promise<boolean> {
	try {
		await repo.git(['merge-base', '--is-ancestor', ancestor, descendant]);
		return true;
	} catch (error) {
		if (error instanceof GitError && error.code === 1) {
			return false;
		}
		throw error;
	}
}

/**
 * Files changed on `to` since its merge base with `from`, NUL-delimited so any filename survives.
 * Renames are reported as a deletion plus an addition, so both names are listed as the API adapter does.
 */
export async function changedFiles(
	repo: GitRepo,
	from: string,
	to: string,
): Promise<string[] | null> {
	let output: string;
	try {
		output = await repo.git(['diff', '--name-only', '-z', '--no-renames', `${from}...${to}`]);
	} catch (error) {
		// Unrelated histories have no merge base, so the diff is indeterminate, like a capped API compare.
		if (error instanceof GitError && /no merge base/i.test(error.stderr)) {
			return null;
		}
		throw error;
	}
	return output.split('\0').filter((name) => name.length > 0);
}

/** Splits a list into the batches one git invocation handles. */
export function chunks<T extends string>(items: T[]): T[][] {
	const result: T[][] = [];
	let current: T[] = [];
	let length = 0;
	for (const item of items) {
		// One argument alone over the bound cannot be batched at all; a GitError keeps `auto` on its fallback path.
		if (item.length + 1 > BATCH_CHARS) {
			throw new GitError(
				['batch'],
				`argument of ${item.length} characters exceeds the command-line budget`,
				undefined,
			);
		}
		if (
			current.length > 0 &&
			(current.length >= REF_BATCH || length + item.length + 1 > BATCH_CHARS)
		) {
			result.push(current);
			current = [];
			length = 0;
		}
		current.push(item);
		length += item.length + 1;
	}
	if (current.length > 0) {
		result.push(current);
	}
	return result;
}
