import { resolve } from 'node:path';
import { globSync, isDynamicPattern } from 'tinyglobby';
import { looksLikeSpec } from './acquire.ts';

/**
 * Expands path-shaped glob targets, so `./packages/*` works whether or not the shell expanded it
 * (Windows shells do not). Specs/URLs are never globbed, so `lodash@*` still reaches pacote.
 * A pattern matching nothing is kept verbatim. Like a shell, this does not de-duplicate.
 */
export function expandGlobTargets(positionals: string[]): string[] {
	return positionals.flatMap((positional) =>
		isDynamicPattern(positional) && !looksLikeSpec(positional)
			? expandGlobTarget(positional)
			: [positional],
	);
}

/**
 * Expands one glob, or keeps it verbatim if nothing matches. tinyglobby can't take a pattern that
 * escapes its `cwd` (`..`) or is absolute, so split at the first glob segment and hand the literal
 * base to it as `cwd`, matching only the relative tail.
 */
function expandGlobTarget(pattern: string): string[] {
	// tinyglobby patterns are `/`-based; fold Windows `\` separators (a legal filename char on POSIX).
	const normalized = process.platform === 'win32' ? pattern.replaceAll('\\', '/') : pattern;
	const segments = normalized.split('/');
	const firstMagic = segments.findIndex((segment) => isDynamicPattern(segment));
	if (firstMagic === -1) {
		return [pattern];
	}
	const base = segments.slice(0, firstMagic).join('/') || '.';
	const tail = segments.slice(firstMagic).join('/');
	let matches: string[];
	try {
		// Match dirs too (the common target), and keep `*` non-recursive like a shell.
		matches = globSync(tail, { cwd: resolve(base), onlyFiles: false, expandDirectories: false });
	} catch {
		// A bad pattern or unreadable dir is kept verbatim, surfacing as a per-target error.
		return [pattern];
	}
	// tinyglobby returns cwd-relative matches (dirs trailing-slashed); re-prefix with the literal base.
	return matches.length > 0
		? matches.toSorted().map((match) => `${base}/${match.replace(/\/+$/, '')}`)
		: [pattern];
}
