/**
 * A Node-only progress renderer that draws a single, self-rewriting status line to stderr while an audit runs.
 * Results go to stdout, so a redirect like `dependency-audit . > out.json` (or `--json`) stays clean — the spinner only ever touches stderr, and only when stderr is an interactive terminal.
 * Everything external is injectable (stream, env, clock, timer) so the renderer is testable without a real TTY; the defaults bind to the live process.
 */
import { clearLine, cursorTo } from 'node:readline';
import type { ProgressEvent, ProgressReporter } from './progress.ts';

/** The subset of a write stream the renderer needs (so tests can pass a fake). */
interface OutputStream {
	isTTY?: boolean;
	write(chunk: string): boolean;
}

/** Cancels a scheduled repeating callback. */
type Cancel = () => void;

export interface TtyReporterOptions {
	/** Total number of targets in this run, for the `X/N` headline. */
	total: number;
	/** Force-disables progress when `false` (e.g. the CLI's `--no-progress`); default enabled. */
	enabled?: boolean;
	/** Where to draw (default `process.stderr`). */
	stream?: OutputStream;
	/** Environment consulted for `NO_PROGRESS` / `NO_COLOR` / `TERM` (default `process.env`). */
	env?: Record<string, string | undefined>;
	/** Monotonic-ish clock in ms (default `Date.now`), used for the elapsed-time suffix. */
	now?: () => number;
	/** Schedules `cb` every `ms`; returns a canceller (default an `unref`'d `setInterval`). */
	schedule?: (cb: () => void, ms: number) => Cancel;
}

/** A live progress renderer plus the handles the CLI needs to keep stderr tidy. */
export interface TtyReporter {
	/** Whether the live UI is active (an interactive TTY, not disabled) — so the CLI can gate a one-off stderr banner the same way as the spinner. */
	enabled: boolean;
	/** The progress sink to thread through `audit()`. A no-op when output is disabled. */
	reporter: ProgressReporter;
	/** Erases the current line without stopping — for interleaving a one-off diagnostic. */
	clear(): void;
	/** Erases the line and stops for good; later events are ignored. Idempotent. */
	stop(): void;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_MS = 100;

/** The disabled reporter — shared so the no-op path allocates nothing per call. */
const NOOP = (): void => {};

/** Per-target phase state, kept just precise enough to describe the current line. */
type TargetState =
	| { phase: 'acquire' }
	| { phase: 'materialize'; done: number; total: number }
	| { phase: 'scan'; surface: 'types' | 'runtime' };

/**
 * Builds a {@link TtyReporter} that draws the spinner to stderr.
 * Every method is a no-op when progress is disabled (`enabled: false` / `NO_PROGRESS`), when stderr is not an interactive TTY (a pipe, a file, CI), or under `TERM=dumb`, so the CLI can wire it unconditionally and machine output stays untouched.
 * `NO_COLOR` only drops the styling, not the spinner itself.
 */
export function createTtyReporter(options: TtyReporterOptions): TtyReporter {
	const stream = options.stream ?? process.stderr;
	const env = options.env ?? process.env;
	const now = options.now ?? Date.now;
	const schedule = options.schedule ?? defaultSchedule;

	const disabledByEnv = env['NO_PROGRESS'] !== undefined && env['NO_PROGRESS'] !== '';
	const enabled =
		options.enabled !== false && !disabledByEnv && Boolean(stream.isTTY) && env['TERM'] !== 'dumb';
	if (!enabled) {
		return { enabled: false, reporter: NOOP, clear: NOOP, stop: NOOP };
	}

	const useColor = env['NO_COLOR'] === undefined || env['NO_COLOR'] === '';
	const dim = (s: string): string => (useColor ? `\x1b[2m${s}\x1b[22m` : s);

	const states = new Map<string, TargetState>();
	const finished = new Set<string>();
	let doneTargets = 0;
	let startedAt: number | undefined;
	let tick = 0;
	let dirty = false;
	let cancel: Cancel | undefined;
	let stopped = false;

	/* A write failed (e.g. the terminal closed) — disable for good rather than throw.
	 * Progress is decorative, so it must never crash or hang the audit, and the CLI calls these methods directly (not via `emit`), so the guard lives here, not only in the core. */
	const disable = (): void => {
		stopped = true;
		cancel?.();
	};

	/* `node:readline` owns the cursor/line control (no hand-rolled escapes).
	 * The minimal `OutputStream` is a structural subset of a real stream, so cast for these calls. */
	const eraseLine = (): void => {
		cursorTo(stream as NodeJS.WritableStream, 0);
		clearLine(stream as NodeJS.WritableStream, 0);
	};

	const render = (): void => {
		try {
			eraseLine();
			stream.write(buildLine());
			dirty = true;
		} catch {
			disable();
		}
	};

	const buildLine = (): string => {
		const frame = SPINNER[tick % SPINNER.length];
		const elapsed = Math.max(0, Math.round((now() - (startedAt ?? now())) / 1000));
		const body =
			options.total === 1
				? describe(soleState())
				: `auditing ${doneTargets}/${options.total} · ${aggregate(states)}`;
		return `${frame} ${body} ${dim(`(${elapsed}s)`)}`;
	};

	const soleState = (): TargetState | undefined => states.values().next().value;

	const clear = (): void => {
		if (!dirty) {
			return;
		}
		try {
			eraseLine();
		} catch {
			disable();
		}
		dirty = false;
	};

	const stop = (): void => {
		if (stopped) {
			return;
		}
		stopped = true;
		cancel?.();
		clear();
	};

	const reporter: ProgressReporter = (event) => {
		if (stopped) {
			return;
		}
		/* Ignore a late event for an already-finished target — a straggler dep can settle (emitting `materialize:progress`) after its target failed, which would otherwise resurrect the deleted state.
		 * `target:done` itself is handled idempotently below. */
		if (event.type !== 'target:done' && finished.has(event.target)) {
			return;
		}
		if (startedAt === undefined) {
			// Start the spinner only once work is actually under way.
			startedAt = now();
			try {
				cancel = schedule(() => {
					tick++;
					render();
				}, FRAME_MS);
			} catch {
				// A scheduler failure must not abort the audit — disable, as with a failed write.
				disable();
				return;
			}
		}
		apply(states, event);
		if (event.type === 'target:done' && !finished.has(event.target)) {
			finished.add(event.target);
			doneTargets++;
		}
		render();
	};

	return { enabled: true, reporter, clear, stop };
}

/** Applies one event to the per-target state map. */
function apply(states: Map<string, TargetState>, event: ProgressEvent): void {
	switch (event.type) {
		case 'acquire:start':
			states.set(event.target, { phase: 'acquire' });
			break;
		case 'materialize:start':
			states.set(event.target, { phase: 'materialize', done: 0, total: event.total });
			break;
		case 'materialize:progress':
			states.set(event.target, {
				phase: 'materialize',
				done: event.done,
				total: event.total,
			});
			break;
		case 'scan:start':
			states.set(event.target, { phase: 'scan', surface: event.surface });
			break;
		case 'target:done':
			states.delete(event.target);
			break;
	}
}

/** A one-target run's detail, e.g. `materializing deps 12/40`. */
function describe(state: TargetState | undefined): string {
	if (state === undefined) {
		return 'auditing';
	}
	switch (state.phase) {
		case 'acquire':
			return 'acquiring';
		case 'materialize':
			return `materializing deps ${state.done}/${state.total}`;
		case 'scan':
			return `scanning ${state.surface}`;
	}
}

/**
 * A multi-target run's detail. Materialization is the long pole, so when any target is
 * fetching deps, summing the counts is the most useful signal; otherwise just note activity.
 */
function aggregate(states: Map<string, TargetState>): string {
	let done = 0;
	let total = 0;
	let materializing = false;
	for (const state of states.values()) {
		if (state.phase === 'materialize') {
			materializing = true;
			done += state.done;
			total += state.total;
		}
	}
	return materializing ? `materializing ${done}/${total} deps` : 'scanning';
}

/** The production scheduler: a repeating timer that never keeps the process alive. */
function defaultSchedule(cb: () => void, ms: number): Cancel {
	const timer = setInterval(cb, ms);
	timer.unref();
	return () => clearInterval(timer);
}
