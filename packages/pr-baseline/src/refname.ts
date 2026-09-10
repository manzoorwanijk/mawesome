/**
 * Baselines live under their own namespace, which clones never fetch, so a move can never clobber a developer's local tag.
 * The REST refs API addresses a ref without the leading `refs/`.
 */
export const BASELINE_REF_PREFIX = 'refs/baselines/';

export function baselineRef(name: string): string {
	return `${BASELINE_REF_PREFIX}${name}`;
}

export function baselineRefPath(name: string): string {
	return baselineRef(name).slice('refs/'.length);
}

/**
 * Validates a baseline name the way `git check-ref-format refs/baselines/<name>` would; `@` alone is valid there.
 * Implemented in TypeScript so validation needs no git binary.
 */
export function isValidRefName(name: string): boolean {
	if (name.length === 0 || name.endsWith('/') || name.startsWith('/')) {
		return false;
	}
	if (name.includes('//') || name.includes('..') || name.includes('@{')) {
		return false;
	}
	if (name.endsWith('.') || name.endsWith('.lock')) {
		return false;
	}
	for (const char of name) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f || ' ~^:?*[\\'.includes(char)) {
			return false;
		}
	}
	return name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}
