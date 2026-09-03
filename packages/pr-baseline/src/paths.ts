import ignore from 'ignore';

/** A gitignore-grammar matcher over repository-relative filenames, shared by every adapter. */
export interface PathMatcher {
	matches(file: string): boolean;
	/** Whether any of the files matches. */
	touches(files: Iterable<string>): boolean;
}

export function createMatcher(patterns: readonly string[]): PathMatcher {
	const matcher = ignore().add([...patterns]);
	const matches = (file: string): boolean => matcher.ignores(normalize(file));
	return {
		matches,
		touches(files) {
			for (const file of files) {
				if (matches(file)) {
					return true;
				}
			}
			return false;
		},
	};
}

/*
 * The `ignore` package rejects leading `./` and `/`, and its wildcards never cross a newline.
 * Git's NUL-delimited output can carry both, so they are normalized before matching.
 */
function normalize(file: string): string {
	let path = file.replaceAll(/[\r\n]/g, '\uFFFD');
	while (path.startsWith('./')) {
		path = path.slice(2);
	}
	return path.startsWith('/') ? path.slice(1) : path;
}
