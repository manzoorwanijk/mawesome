/**
 * Validates a tag name the way `git check-ref-format refs/tags/<name>` would; `@` alone is valid there.
 * Implemented in TypeScript so validation needs no git binary.
 */
export function isValidTagName(name: string): boolean {
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
