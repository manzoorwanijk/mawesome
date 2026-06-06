/**
 * Browser engine for the dependency-audit playground.
 *
 * Runs the audit entirely client-side: resolve a package spec, fetch its tarball from a CDN,
 * gunzip + untar it into an in-memory filesystem, and run `auditPackage` from the runtime-agnostic
 * `@mawesome/dependency-audit/browser` core. A {@link RegistryProvider} materializes the target's
 * declared dependencies the same way, so resolution runs against the *declared* ranges — never an
 * author's ambient `node_modules`. No server, no install.
 *
 * The core pulls in TypeScript (for the `.d.ts` surface), so it is imported dynamically: the heavy
 * chunk only loads when an audit actually runs.
 */
import { parseTar } from 'nanotar';
import type {
	AuditResult,
	RegistryProvider,
	WritableFileSystem,
} from '@mawesome/dependency-audit/browser';

const REGISTRY = 'https://registry.npmjs.org';
const JSDELIVR_RESOLVE = 'https://data.jsdelivr.com/v1/packages/npm';

/** Bounds so a huge package or a decompression bomb can't freeze or OOM the tab. */
const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 96 * 1024 * 1024;
const MAX_ENTRIES = 24_000;

/**
 * A permissive npm package name (scope optional). Rejects URLs, paths, and whitespace so a spec
 * can't smuggle extra path segments into the request URLs; the explicit `..` guard blocks traversal.
 */
function isValidPackageName(name: string): boolean {
	return /^(?:@[a-z0-9-._~]+\/)?[a-z0-9-._~]+$/i.test(name) && !name.includes('..');
}

export interface ParsedSpec {
	name: string;
	/** A semver range, exact version, or dist-tag; defaults to `latest`. */
	range: string;
}

/** Split `name`, `name@range`, `@scope/name`, or `@scope/name@range` into name + range. */
export function parseSpec(input: string): ParsedSpec {
	const spec = input.trim();
	const at = spec.lastIndexOf('@');
	// `at <= 0` covers a bare name and a scope-only `@scope/name` (the `@` is at index 0).
	if (at <= 0) return { name: spec, range: 'latest' };
	return { name: spec.slice(0, at), range: spec.slice(at + 1) || 'latest' };
}

/** Resolve a range/tag/version to a concrete published version via jsDelivr's resolve API. */
async function resolveVersion(
	name: string,
	range: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const specifier = range && range !== '*' ? range : 'latest';
	const url = `${JSDELIVR_RESOLVE}/${name}/resolved?specifier=${encodeURIComponent(specifier)}`;
	const res = await fetch(url, { signal });
	if (!res.ok) return undefined;
	const body = (await res.json()) as { version?: string | null };
	return body.version ?? undefined;
}

/** The npm registry tarball URL for a resolved `name@version` (scope dropped from the basename). */
function tarballUrl(name: string, version: string): string {
	const unscoped = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
	return `${REGISTRY}/${name}/-/${unscoped}-${version}.tgz`;
}

/** Gunzip a response body, aborting if the inflated size exceeds `maxBytes` (decompression-bomb guard). */
async function gunzipCapped(
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<Uint8Array> {
	// DecompressionStream's lib.dom generics (ArrayBuffer vs ArrayBufferLike) don't line up with
	// `pipeThrough` here; the runtime contract (Uint8Array in/out) is correct.
	const transform = new DecompressionStream('gzip') as unknown as ReadableWritablePair<
		Uint8Array,
		Uint8Array
	>;
	const reader = body.pipeThrough(transform).getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		// eslint-disable-next-line no-await-in-loop -- streaming requires sequential, backpressured reads
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			void reader.cancel();
			throw new Error('Package is too large to audit in the browser.');
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/** Fetch + gunzip + untar `name@version`, writing its files under `destDir` (npm's `package/` stripped). */
async function extractInto(
	fs: WritableFileSystem,
	name: string,
	version: string,
	destDir: string,
	signal?: AbortSignal,
): Promise<void> {
	const res = await fetch(tarballUrl(name, version), { signal });
	if (!res.ok || !res.body)
		throw new Error(`Could not fetch ${name}@${version} (HTTP ${res.status}).`);
	// Fail fast on an advertised oversize download; a missing/!finite header just falls through to
	// the streaming decompressed cap below, which is the real bomb guard.
	const compressed = Number(res.headers.get('content-length'));
	if (Number.isFinite(compressed) && compressed > MAX_COMPRESSED_BYTES) {
		throw new Error('Package is too large to audit in the browser.');
	}
	const files = parseTar(await gunzipCapped(res.body, MAX_DECOMPRESSED_BYTES));
	if (files.length > MAX_ENTRIES)
		throw new Error('Package has too many files to audit in the browser.');
	for (const file of files) {
		if (file.type && file.type !== 'file') continue;
		/* Strip the leading path segment (tar `strip: 1`), like pacote/npm does. The root is
		 * conventionally `package/` but isn't guaranteed — DefinitelyTyped `@types/*` tarballs
		 * root under names like `react v18.3/` — so strip by position, not by a fixed prefix. */
		const slash = file.name.indexOf('/');
		if (slash === -1) continue;
		const rel = file.name.slice(slash + 1);
		// Reject `..` as a path *segment* (traversal) but keep names that merely contain `..`.
		if (rel && !rel.split('/').includes('..')) fs.writeFile(`${destDir}/${rel}`, file.text);
	}
}

/** A provider that materializes declared deps into the in-memory fs from the CDN. */
function createCdnProvider(fs: WritableFileSystem, signal?: AbortSignal): RegistryProvider {
	return {
		async materialize(name, range, intoDir) {
			const version = await resolveVersion(name, range, signal);
			if (!version) return undefined;
			await extractInto(fs, name, version, `${intoDir}/node_modules/${name}`, signal);
			return version;
		},
	};
}

export interface AuditRun {
	/** The exact `name@version` audited (after resolving the input range/tag). */
	resolved: string;
	result: AuditResult;
}

/** Resolve, fetch, and audit a package spec entirely in the browser. */
export async function runAudit(input: string, signal?: AbortSignal): Promise<AuditRun> {
	const { name, range } = parseSpec(input);
	if (!name) throw new Error('Enter a package name (e.g. "react" or "lodash@4").');
	if (!isValidPackageName(name)) throw new Error(`"${name}" is not a valid npm package name.`);

	const version = await resolveVersion(name, range, signal);
	if (!version) throw new Error(`No published version of "${name}" matches "${range}".`);

	const { auditPackage, createMemoryFileSystem } =
		await import('@mawesome/dependency-audit/browser');
	const fs = createMemoryFileSystem();
	await extractInto(fs, name, version, '/pkg', signal);

	const result = await auditPackage(fs, '/pkg', {
		workDir: '/work',
		provider: createCdnProvider(fs, signal),
		target: `${name}@${version}`,
	});
	return { resolved: `${name}@${version}`, result };
}
