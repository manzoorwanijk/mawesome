import { resolve } from 'node:path';
import { globSync, isDynamicPattern } from 'tinyglobby';
import { looksLikeSpec } from './acquire.ts';

/**
 * Expands path-shaped glob targets ourselves so a pattern like `./packages/*` resolves the same
 * regardless of the invoking shell: a POSIX shell expands it before we see it (those concrete
 * paths are magic-free and pass straight through), while Windows `cmd.exe`/PowerShell hand us the
 * literal pattern. Specs and URLs (`looksLikeSpec`) are never globbed, so `lodash@*` still reaches
 * pacote. A pattern that matches nothing is kept verbatim, surfacing as a clear "Target not found".
 * Like a POSIX shell, this does not de-duplicate: a repeated target — or overlapping globs — audits
 * each match once per occurrence.
 */
export function expandGlobTargets(positionals: string[]): string[] {
	return positionals.flatMap((positional) =>
		isDynamicPattern(positional) && !looksLikeSpec(positional)
			? expandGlobTarget(positional)
			: [positional],
	);
}

/**
 * Expands one glob to its sorted matches, or keeps it verbatim if none match. tinyglobby does the
 * filesystem matching, but it can't take a pattern that escapes its `cwd` (`..`) or is absolute —
 * so we split the pattern at its first glob segment, hand the literal base (which *may* be `..` or
 * absolute) to tinyglobby as `cwd`, and match only the relative tail under it. Delegating the walk
 * to a maintained matcher keeps symlink/traversal/regex handling out of our hands.
 */
function expandGlobTarget(pattern: string): string[] {
	// On Windows a glob may arrive with `\` separators; tinyglobby patterns are `/`-based, so fold
	// them. On POSIX `\` is a legal filename char, so it is left intact there.
	const normalized = process.platform === 'win32' ? pattern.replaceAll('\\', '/') : pattern;
	const segments = normalized.split('/');
	const firstMagic = segments.findIndex((segment) => isDynamicPattern(segment));
	// `isDynamicPattern(pattern)` was true, so some segment has magic; this guards the type only.
	if (firstMagic === -1) {
		return [pattern];
	}
	const base = segments.slice(0, firstMagic).join('/') || '.';
	const tail = segments.slice(firstMagic).join('/');
	let matches: string[];
	try {
		// `onlyFiles: false` so directory targets match (the common case is package dirs);
		// `expandDirectories: false` keeps `*` non-recursive, like a shell.
		matches = globSync(tail, { cwd: resolve(base), onlyFiles: false, expandDirectories: false });
	} catch {
		// A malformed pattern or unreadable dir keeps the target verbatim, so it surfaces as a clear
		// per-target error rather than aborting the whole run.
		return [pattern];
	}
	// tinyglobby returns matches relative to `base`'s cwd (dirs with a trailing slash); re-prefix with
	// the original (possibly relative) base so a target reads naturally and resolves the same.
	return matches.length > 0
		? matches.toSorted().map((match) => `${base}/${match.replace(/\/+$/, '')}`)
		: [pattern];
}
