import { styleText } from 'node:util';

/**
 * Thin wrappers over `node:util` `styleText`, which auto-detects whether `process.stdout`
 * is a color-capable TTY and honors `NO_COLOR` / `FORCE_COLOR` — so piping the output to a
 * file or another program yields plain text with no extra plumbing. (`styleText` knows
 * nothing about CLI flags; `--json` output stays plain because that path never calls these
 * helpers, not because `styleText` detects it.)
 *
 * Pad *before* coloring: ANSI escapes have zero display width, so padding a colored string
 * would misalign columns.
 */
export const color = {
	bold: (s: string): string => styleText('bold', s),
	dim: (s: string): string => styleText('dim', s),
	red: (s: string): string => styleText('red', s),
	green: (s: string): string => styleText('green', s),
	yellow: (s: string): string => styleText('yellow', s),
};
