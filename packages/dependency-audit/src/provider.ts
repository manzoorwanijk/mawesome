import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import pacote from 'pacote';
import { DEFAULT_EXTRACT_LIMITS, ExtractLimitError, extractTarball } from './extract.ts';
import { withRetry } from './retry.ts';
import type { ExtractLimits, RegistryProvider } from './types.ts';
import { buildWorkspaceIndex } from './workspace.ts';

/** Options for {@link createPacoteProvider}. */
export interface PacoteProviderOptions {
	/** Extraction caps (decompression-bomb guard). */
	limits?: ExtractLimits | undefined;
	/**
	 * The directory `file:` ranges resolve relative to — the audited package's own dir.
	 * Lets a monorepo package's `file:../sibling` deps materialize from the local (built)
	 * sibling instead of failing as a registry lookup.
	 */
	where?: string | undefined;
	/** Extra attempts for a transient registry fetch/extract failure (default {@link DEFAULT_RETRIES}). */
	retries?: number | undefined;
}

const FILE_PREFIX = 'file:';
const LINK_PREFIX = 'link:';
const WORKSPACE_PREFIX = 'workspace:';

/** Default extra registry attempts — 3 retries (4 calls total) absorbs transient races under load. */
export const DEFAULT_RETRIES = 3;

const RECURSIVE = { recursive: true, force: true } as const;

/**
 * Builds the default registry provider. A `name@range` is fetched from npm at the highest
 * satisfying version and bomb-guard-extracted; a monorepo-local range is materialized
 * without a rebuild (staying fully static): a `file:` path (resolved relative to `where`)
 * or a `workspace:` dep (resolved by name through the workspace) links the local sibling
 * directory, and a local `.tgz` is extracted. Fetches reuse npm's cache/auth via pacote.
 */
export function createPacoteProvider(options: PacoteProviderOptions = {}): RegistryProvider {
	const limits = options.limits ?? DEFAULT_EXTRACT_LIMITS;
	const where = options.where;
	const retries = options.retries ?? DEFAULT_RETRIES;
	// The workspace index is built once, lazily, on the first `workspace:` dep.
	let workspace: Map<string, string> | undefined | null;
	const workspaceDir = (name: string): string | undefined => {
		if (workspace === undefined) {
			workspace = where === undefined ? null : (buildWorkspaceIndex(where) ?? null);
		}
		return workspace?.get(name);
	};

	return {
		async materialize(name: string, range: string, intoDir: string): Promise<string | undefined> {
			const dest = join(intoDir, 'node_modules', name);

			/* `file:`/`link:` ranges point at a local directory or tarball — resolve them
			 * ourselves so a local spec never reaches pacote's `DirFetcher` (which would
			 * need an Arborist tree to pack a directory that has its own dependencies).
			 * A local failure is deterministic (a bad path stays bad), so it degrades to
			 * "absent" (undefined) rather than erroring the whole target — and is never retried. */
			if (range.startsWith(FILE_PREFIX) || range.startsWith(LINK_PREFIX)) {
				if (where === undefined) {
					return undefined;
				}
				return absentOnFailure(name, range, dest, () =>
					materializeLocal(resolve(where, localPath(range)), dest, limits),
				);
			}
			if (range.startsWith(WORKSPACE_PREFIX)) {
				// Resolve the workspace index inside the guard too: building it reads the
				// workspace file, which can throw — a local lookup failure must degrade to
				// absence, never error the whole target.
				return absentOnFailure(name, range, dest, () => {
					const dir = workspaceDir(workspaceTarget(name, range));
					return Promise.resolve(dir === undefined ? undefined : linkDir(dir, dest));
				});
			}

			/* Registry spec: a failure is far more often a transient race (shared npm cache,
			 * flaky network under heavy concurrency) than a genuine absence, so retry with
			 * backoff. An exhausted retry *throws* so the caller fails the target with an
			 * honest error (exit 2) — never silently degrading into a false "undeclared" finding. */
			try {
				return await withRetry(() => fetchAndExtract(name, range, dest, where, limits), {
					retries,
					baseDelayMs: 150,
					maxDelayMs: 2000,
					// A decompression-bomb guard is deliberate — never retry or mask it.
					shouldRetry: (error) => !(error instanceof ExtractLimitError),
				});
			} catch (error) {
				throw materializeError(name, range, error);
			}
		},
	};
}

/** Fetches and bomb-guard-extracts a registry tarball, leaving no partial tree behind on failure. */
async function fetchAndExtract(
	name: string,
	range: string,
	dest: string,
	where: string | undefined,
	limits: ExtractLimits,
): Promise<string | undefined> {
	try {
		const fetched = await pacote.tarball(`${name}@${range}`, { where });
		await extractTarball(fetched, dest, limits);
		return readVersion(dest);
	} catch (error) {
		// Clear the partial extraction before a retry or the rethrow; rethrow the original
		// error so `shouldRetry` still sees its real type (e.g. ExtractLimitError).
		rmSync(dest, RECURSIVE);
		throw error;
	}
}

/**
 * Runs `materialize`, treating a failure as a (cleaned-up) absence — for local specs only.
 * An `ExtractLimitError` is re-thrown (named, like the registry path), never masked: the
 * decompression-bomb guard is deliberate even for a local `.tgz`, so a hostile/oversized
 * archive must fail the target, not look absent.
 */
async function absentOnFailure(
	name: string,
	range: string,
	dest: string,
	materialize: () => Promise<string | undefined>,
): Promise<string | undefined> {
	try {
		return await materialize();
	} catch (error) {
		rmSync(dest, RECURSIVE);
		if (error instanceof ExtractLimitError) {
			throw materializeError(name, range, error);
		}
		return undefined;
	}
}

/** A target error naming the dependency, with the underlying failure preserved as `cause`. */
function materializeError(name: string, range: string, cause: unknown): Error {
	return new Error(`Failed to materialize ${name}@${range}: ${messageOf(cause)}`, { cause });
}

/** An error's message, without leaking a non-Error's shape. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Materializes a `file:` dependency: link a local directory, or extract a local `.tgz`. */
async function materializeLocal(
	src: string,
	dest: string,
	limits: ExtractLimits,
): Promise<string | undefined> {
	if (statSync(src).isDirectory()) {
		return linkDir(src, dest);
	}
	await extractTarball(readFileSync(src), dest, limits);
	return readVersion(dest);
}

/**
 * Symlinks an already-built local package so resolution reads its real manifest/artifacts
 * without copying it or running its build scripts (fully static).
 */
function linkDir(src: string, dest: string): string | undefined {
	mkdirSync(dirname(dest), { recursive: true });
	symlinkSync(src, dest, 'dir');
	return readVersion(dest);
}

function readVersion(dir: string): string | undefined {
	const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string };
	return pkg.version;
}

/** The local path of a `file:`/`link:` range, expanding a leading `~` to the home directory. */
function localPath(range: string): string {
	const prefix = range.startsWith(LINK_PREFIX) ? LINK_PREFIX : FILE_PREFIX;
	const spec = range.slice(prefix.length);
	return spec.startsWith('~') ? homedir() + spec.slice(1) : spec;
}

/**
 * The workspace package name a `workspace:` range points at: the alias target for
 * `workspace:name@version` (e.g. `workspace:foo@*` → `foo`), else the dependency's own
 * name (`workspace:*`/`^`/`~`/`<version>`).
 */
function workspaceTarget(name: string, range: string): string {
	const body = range.slice(WORKSPACE_PREFIX.length);
	const at = body.lastIndexOf('@');
	return at > 0 ? body.slice(0, at) : name;
}

/** The default registry provider (default extraction caps, no `file:` resolution base). */
export const pacoteProvider: RegistryProvider = createPacoteProvider();
