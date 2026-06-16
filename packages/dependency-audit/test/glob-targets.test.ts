import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { expandGlobTargets } from '../src/glob-targets.ts';

/*
 * Hermetic unit coverage for the CLI's internal glob expansion — no subprocess, no registry. A
 * fixture dir holds two package-like dirs (one with a nested file), a stray file, and a dotdir;
 * patterns use the dir's absolute path as the (literal) base so matching never depends on the test
 * runner's cwd.
 */
describe('expandGlobTargets', () => {
	/*
	 * `dir` (native separators) seeds the filesystem; `base` is its `/`-spelled form — the expander
	 * normalizes patterns to `/`, so a matched target reads back with `/` on every OS (a real call
	 * passes `/` too). Patterns and expectations use `base`.
	 */
	let dir: string;
	let base: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'da-glob-unit-'));
		base = dir.replaceAll('\\', '/');
		mkdirSync(join(dir, 'pkg-a'));
		mkdirSync(join(dir, 'pkg-b'));
		mkdirSync(join(dir, '.hidden'));
		writeFileSync(join(dir, 'readme.md'), '# x');
		writeFileSync(join(dir, 'pkg-a', 'deep.js'), 'x');
	});

	it('expands `<base>/*` to every immediate child — files and dirs, dotfiles excluded', () => {
		expect(expandGlobTargets([`${base}/*`])).toEqual([
			`${base}/pkg-a`,
			`${base}/pkg-b`,
			`${base}/readme.md`,
		]);
	});

	it('matches a partial-segment glob (`pkg-*`) and a single-char `?`', () => {
		expect(expandGlobTargets([`${base}/pkg-*`])).toEqual([`${base}/pkg-a`, `${base}/pkg-b`]);
		expect(expandGlobTargets([`${base}/pkg-?`])).toEqual([`${base}/pkg-a`, `${base}/pkg-b`]);
	});

	it('matches dotfiles only when the segment is itself dot-led', () => {
		expect(expandGlobTargets([`${base}/.*`])).toEqual([`${base}/.hidden`]);
	});

	it('expands a multi-segment tail (`*/deep.js`)', () => {
		expect(expandGlobTargets([`${base}/*/deep.js`])).toEqual([`${base}/pkg-a/deep.js`]);
	});

	it('resolves a `..` in the base (the tail is matched under the resolved dir)', () => {
		// `<dir>/pkg-a/..` resolves to `<dir>`; the literal base is preserved in the returned target.
		expect(expandGlobTargets([`${base}/pkg-a/../pkg-*`])).toEqual([
			`${base}/pkg-a/../pkg-a`,
			`${base}/pkg-a/../pkg-b`,
		]);
	});

	it('keeps a pattern that matches nothing verbatim (surfaces as a clear not-found later)', () => {
		expect(expandGlobTargets([`${base}/__none__*`])).toEqual([`${base}/__none__*`]);
	});

	it('does not de-duplicate — overlapping globs each expand in full', () => {
		expect(expandGlobTargets([`${base}/pkg-*`, `${base}/pkg-*`])).toEqual([
			`${base}/pkg-a`,
			`${base}/pkg-b`,
			`${base}/pkg-a`,
			`${base}/pkg-b`,
		]);
	});

	it('never globs a published spec or URL, even when it contains `*`/`?`', () => {
		// A registry spec and a tarball URL must reach pacote untouched, not the filesystem.
		expect(expandGlobTargets(['lodash@*'])).toEqual(['lodash@*']);
		expect(expandGlobTargets(['https://example.test/x.tgz?t=1'])).toEqual([
			'https://example.test/x.tgz?t=1',
		]);
	});

	it('leaves magic-free targets, and slash-free bare globs, untouched', () => {
		// `*`/`pkg-*` without a path separator read as specs (use `./*`), so they are kept verbatim.
		expect(expandGlobTargets([`${base}/pkg-a`, './local', '*', 'pkg-*'])).toEqual([
			`${base}/pkg-a`,
			'./local',
			'*',
			'pkg-*',
		]);
	});
});
