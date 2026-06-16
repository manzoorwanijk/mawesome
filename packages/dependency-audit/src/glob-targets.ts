import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { looksLikeSpec } from './acquire.ts';

/** Glob magic that triggers internal expansion — `*` (any run) and `?` (one char). */
const GLOB_MAGIC = /[*?]/;

/**
 * Expands path-shaped glob targets ourselves so a pattern like `./packages/*` resolves the same
 * regardless of the invoking shell: a POSIX shell expands it before we see it (those concrete
 * paths are magic-free and pass straight through), while Windows `cmd.exe`/PowerShell hand us the
 * literal pattern. The magic must be confined to the final path segment — the leading base (which
 * may use `.`, `..`, or be absolute) is literal — and the segment is matched against the base
 * directory's immediate children, mirroring a shell's non-recursive `*`. Specs and URLs
 * (`looksLikeSpec`) are never globbed, so `lodash@*` still reaches pacote. A pattern that matches
 * nothing is kept verbatim, surfacing as a clear "Target not found". Like a POSIX shell, this does
 * not de-duplicate: a repeated target — or overlapping globs — audits each match once per occurrence.
 *
 * Hand-rolled rather than `node:fs`'s `globSync` because that only exists on Node 22+, below the
 * package's `^20.19` floor; replace this with `globSync` once Node 20 support is dropped.
 */
export function expandGlobTargets(positionals: string[]): string[] {
	return positionals.flatMap((positional) =>
		GLOB_MAGIC.test(positional) && !looksLikeSpec(positional)
			? expandGlobTarget(positional)
			: [positional],
	);
}

/** Expands one path-shaped glob to its sorted matches, or keeps it verbatim if none match. */
function expandGlobTarget(pattern: string): string[] {
	const slash = pattern.lastIndexOf('/');
	const segment = slash === -1 ? pattern : pattern.slice(slash + 1);
	// `<base>` is the literal lead-in (`packages`, `../../packages`, `/abs`, or `.` for a bare glob).
	const base = slash === -1 ? '.' : pattern.slice(0, slash) || '/';
	const prefix = slash === -1 ? './' : `${base === '/' ? '' : base}/`;
	// Only the final segment may be a glob; magic in the base isn't expanded (kept verbatim).
	if (GLOB_MAGIC.test(base)) {
		return [pattern];
	}
	const matcher = segmentToRegExp(segment);
	// A leading dot in a name is only matched when the pattern's segment is itself dot-led (shell rule).
	const includeDotfiles = segment.startsWith('.');
	const matches = safeReaddir(resolve(base))
		.filter((name) => (includeDotfiles || !name.startsWith('.')) && matcher.test(name))
		.toSorted()
		.map((name) => `${prefix}${name}`);
	return matches.length > 0 ? matches : [pattern];
}

/** Compiles a single path segment's glob (`*` → any run, `?` → one char) to an anchored RegExp. */
function segmentToRegExp(segment: string): RegExp {
	let source = '^';
	for (const char of segment) {
		source +=
			char === '*' ? '[^/]*' : char === '?' ? '[^/]' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`${source}$`);
}

/** Directory entries, or `[]` if the path is missing or unreadable (a stray base never throws). */
function safeReaddir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}
