import { describe, expect, it } from 'vitest';
import { createMatcher } from '../../src/paths.ts';

describe('createMatcher', () => {
	it('matches gitignore grammar: directories, anchors, globs and negation', () => {
		const matcher = createMatcher(['packages/a/', '/.nvmrc', '*.lock', '!keep.lock']);
		expect(matcher.matches('packages/a/src/index.ts')).toBe(true);
		expect(matcher.matches('packages/ab/src/index.ts')).toBe(false);
		expect(matcher.matches('.nvmrc')).toBe(true);
		expect(matcher.matches('nested/.nvmrc')).toBe(false);
		expect(matcher.matches('pnpm-lock.lock')).toBe(true);
		expect(matcher.matches('keep.lock')).toBe(false);
	});

	it('handles odd filenames and leading ./ or /', () => {
		const matcher = createMatcher(['docs/**']);
		expect(matcher.matches('docs/with space.md')).toBe(true);
		expect(matcher.matches('docs/new\nline.md')).toBe(true);
		expect(matcher.matches('./docs/a.md')).toBe(true);
		expect(matcher.matches('/docs/a.md')).toBe(true);
		// A backslash is an ordinary character in a git filename, not a separator.
		expect(matcher.matches('docs\\win.md')).toBe(false);
	});

	it('touches reports whether any file matches', () => {
		const matcher = createMatcher(['.github/workflows/']);
		expect(matcher.touches(['README.md', '.github/workflows/ci.yml'])).toBe(true);
		expect(matcher.touches(['README.md'])).toBe(false);
		expect(matcher.touches([])).toBe(false);
	});
});
