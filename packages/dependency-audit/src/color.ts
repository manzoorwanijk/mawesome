import { styleText } from 'node:util';

/**
 * Whether to emit ANSI styling on `stream`, decided once at load. `styleText` on its own gates on
 * the stream's `isTTY`, which is false under a pipe — including GitHub Actions, whose log viewer
 * nonetheless renders ANSI. So we decide here and, when enabled, force styling past that gate
 * (`validateStream: false`), while still honoring the `NO_COLOR` / `FORCE_COLOR` conventions and
 * staying plain on an ordinary redirect. Keyed per stream so a `2>log` redirect of stderr stays
 * plain even while stdout (a TTY) is colored. `--json` output stays plain because that path never
 * calls these helpers.
 *
 * Pad *before* coloring: ANSI escapes have zero display width, so padding a colored string
 * would misalign columns.
 */
function decideColor(stream: NodeJS.WriteStream): boolean {
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
	return Boolean(stream.isTTY) || env['GITHUB_ACTIONS'] === 'true';
}

/** The styling helpers a palette exposes — one per ANSI style used in the output. */
type Palette = Record<'bold' | 'dim' | 'red' | 'green' | 'yellow', (s: string) => string>;

/** A palette over a stream that's been decided color-capable (or not) by {@link decideColor}. */
function palette(enabled: boolean): Palette {
	const paint = (format: Parameters<typeof styleText>[0], s: string): string =>
		enabled ? styleText(format, s, { validateStream: false }) : s;
	return {
		bold: (s) => paint('bold', s),
		dim: (s) => paint('dim', s),
		red: (s) => paint('red', s),
		green: (s) => paint('green', s),
		yellow: (s) => paint('yellow', s),
	};
}

/** Styling for stdout (the report) and stderr (diagnostics), each keyed to its own stream. */
export const color: Palette = palette(decideColor(process.stdout));
export const colorErr: Palette = palette(decideColor(process.stderr));
