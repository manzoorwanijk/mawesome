import { styleText } from 'node:util';

/**
 * Whether to emit ANSI styling, decided once at load. `styleText` on its own gates on
 * `process.stdout.isTTY`, which is false under a pipe — including GitHub Actions, whose log
 * viewer nonetheless renders ANSI. So we decide here and, when enabled, force styling past that
 * gate (`validateStream: false`), while still honoring the `NO_COLOR` / `FORCE_COLOR` conventions
 * and staying plain on an ordinary redirect. `--json` output stays plain because that path never
 * calls these helpers.
 *
 * Pad *before* coloring: ANSI escapes have zero display width, so padding a colored string
 * would misalign columns.
 */
function decideColor(): boolean {
	const env = process.env;
	// NO_COLOR (any non-empty value) wins over everything — https://no-color.org.
	if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') {
		return false;
	}
	// FORCE_COLOR opts in explicitly (or, set to 0/false, out).
	const force = env['FORCE_COLOR'];
	if (force !== undefined) {
		return force !== '0' && force !== 'false';
	}
	// An interactive terminal, or GitHub Actions — not a TTY, but its logs render ANSI.
	return Boolean(process.stdout.isTTY) || env['GITHUB_ACTIONS'] === 'true';
}

const useColor = decideColor();

/** Apply `format`, forcing past `styleText`'s own TTY check since {@link decideColor} already ruled. */
function paint(format: Parameters<typeof styleText>[0], s: string): string {
	return useColor ? styleText(format, s, { validateStream: false }) : s;
}

export const color = {
	bold: (s: string): string => paint('bold', s),
	dim: (s: string): string => paint('dim', s),
	red: (s: string): string => paint('red', s),
	green: (s: string): string => paint('green', s),
	yellow: (s: string): string => paint('yellow', s),
};
