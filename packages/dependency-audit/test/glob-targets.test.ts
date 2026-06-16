import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { expandGlobTargets } from '../src/glob-targets.ts';

/*
 * Hermetic unit coverage for the CLI's internal glob expansion — no subprocess, no registry. A
 * fixture dir holds two package-like dirs, a stray file, and a dotdir; patterns use the dir's
 * absolute path as the (literal) base so matching never depends on the test runner's cwd.
 */
describe('expandGlobTargets', () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'da-glob-unit-'));
		mkdirSync(join(dir, 'pkg-a'));
		mkdirSync(join(dir, 'pkg-b'));
		mkdirSync(join(dir, '.hidden'));
		writeFileSync(join(dir, 'readme.md'), '# x');
	});

	it('expands `<base>/*` to every immediate child — files and dirs, dotfiles excluded', () => {
		expect(expandGlobTargets([`${dir}/*`])).toEqual([
			`${dir}/pkg-a`,
			`${dir}/pkg-b`,
			`${dir}/readme.md`,
		]);
	});

	it('matches a partial-segment glob (`pkg-*`) and a single-char `?`', () => {
		expect(expandGlobTargets([`${dir}/pkg-*`])).toEqual([`${dir}/pkg-a`, `${dir}/pkg-b`]);
		expect(expandGlobTargets([`${dir}/pkg-?`])).toEqual([`${dir}/pkg-a`, `${dir}/pkg-b`]);
	});

	it('matches dotfiles only when the segment is itself dot-led', () => {
		expect(expandGlobTargets([`${dir}/.*`])).toEqual([`${dir}/.hidden`]);
	});

	it('keeps a pattern that matches nothing verbatim (surfaces as a clear not-found later)', () => {
		expect(expandGlobTargets([`${dir}/__none__*`])).toEqual([`${dir}/__none__*`]);
	});

	it('does not de-duplicate — overlapping globs each expand in full', () => {
		expect(expandGlobTargets([`${dir}/pkg-*`, `${dir}/pkg-*`])).toEqual([
			`${dir}/pkg-a`,
			`${dir}/pkg-b`,
			`${dir}/pkg-a`,
			`${dir}/pkg-b`,
		]);
	});

	it('never globs a published spec or URL, even when it contains `*`/`?`', () => {
		// A registry spec and a tarball URL must reach pacote untouched, not the filesystem.
		expect(expandGlobTargets(['lodash@*'])).toEqual(['lodash@*']);
		expect(expandGlobTargets(['https://example.test/x.tgz?t=1'])).toEqual([
			'https://example.test/x.tgz?t=1',
		]);
	});

	it('leaves magic-free targets untouched', () => {
		expect(expandGlobTargets([`${dir}/pkg-a`, './local', 'pkg-spec'])).toEqual([
			`${dir}/pkg-a`,
			'./local',
			'pkg-spec',
		]);
	});

	it('does not expand magic in a non-final segment — kept verbatim', () => {
		expect(expandGlobTargets([`${dir}/*/nested`])).toEqual([`${dir}/*/nested`]);
	});
});
