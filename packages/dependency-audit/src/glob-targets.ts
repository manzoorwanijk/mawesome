import { resolve } from 'node:path';
import { globSync, isDynamicPattern } from 'tinyglobby';
import { looksLikeSpec } from './acquire.ts';

/**
 * Expands path-shaped glob targets, so `./packages/*` works whether or not the shell expanded it
 * (Windows shells do not). Specs/URLs are never globbed, so `lodash@*` still reaches pacote.
 * A pattern matching nothing is kept verbatim. Like a shell, this does not de-duplicate.
 */
export function expandGlobTargets(positionals: string[]): string[] {
	return positionals.flatMap((positional) => {
		// tinyglobby patterns are `/`-based; fold Windows `\` (a legal filename char on POSIX) before
		// classifying, so a backslash-spelled glob is recognized rather than mistaken for a spec.
		const pattern = process.platform === 'win32' ? positional.replaceAll('\\', '/') : positional;
		return isDynamicPattern(pattern) && !looksLikeSpec(pattern)
			? expandGlobTarget(pattern)
			: [positional];
	});
}

/**
 * Expands one glob, or keeps it verbatim if nothing matches. tinyglobby can't take a pattern that
 * escapes its `cwd` (`..`) or is absolute, so split at the first glob segment and hand the literal
 * base to it as `cwd`, matching only the relative tail.
 */
function expandGlobTarget(pattern: string): string[] {
	const segments = pattern.split('/');
	const firstMagic = segments.findIndex((segment) => isDynamicPattern(segment));
	// A brace group spanning `/` (e.g. `{a/b,c}`) is dynamic as a whole but in no single segment, so
	// it has no base/tail split — keep it verbatim.
	if (firstMagic === -1) {
		return [pattern];
	}
	// An empty leading segment means an absolute pattern, whose base is the root rather than cwd.
	const base = segments.slice(0, firstMagic).join('/') || (segments[0] === '' ? '/' : '.');
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
	const prefix = base === '/' ? '/' : `${base}/`;
	return matches.length > 0
		? matches.toSorted().map((match) => `${prefix}${match.replace(/\/+$/, '')}`)
		: [pattern];
}
