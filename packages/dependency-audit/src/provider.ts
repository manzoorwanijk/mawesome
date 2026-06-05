import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import pacote from 'pacote';
import { DEFAULT_EXTRACT_LIMITS, extractTarball } from './extract.ts';
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
}

const FILE_PREFIX = 'file:';
const LINK_PREFIX = 'link:';
const WORKSPACE_PREFIX = 'workspace:';

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
			try {
				/* `file:`/`link:` ranges point at a local directory or tarball — resolve them
				 * ourselves so a local spec never reaches pacote's `DirFetcher` (which would
				 * need an Arborist tree to pack a directory that has its own dependencies). */
				if (range.startsWith(FILE_PREFIX) || range.startsWith(LINK_PREFIX)) {
					return where === undefined
						? undefined
						: materializeLocal(resolve(where, localPath(range)), dest, limits);
				}
				if (range.startsWith(WORKSPACE_PREFIX)) {
					const dir = workspaceDir(workspaceTarget(name, range));
					return dir === undefined ? undefined : linkDir(dir, dest);
				}
				const fetched = await pacote.tarball(`${name}@${range}`, { where });
				await extractTarball(fetched, dest, limits);
				return readVersion(dest);
			} catch {
				// Don't leave a partial extraction that could resolve to a broken tree.
				rmSync(dest, { recursive: true, force: true });
				return undefined;
			}
		},
	};
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
