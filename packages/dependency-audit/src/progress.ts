/**
 * Progress events emitted while auditing, and the sink that consumes them.
 *
 * This module is pure (no `process`, no I/O) so it stays browser-safe and can be threaded
 * through the runtime-agnostic core. The Node CLI supplies a stderr renderer; every other
 * host (the browser, tests) supplies none, and each emit is a no-op.
 */

/**
 * A point in a single target's audit lifecycle. `target` is the caller-supplied label.
 * The Node {@link audit} entry emits `acquire:start` … `target:done` (the latter on every path,
 * including a failure or skip); the browser core {@link auditPackage} starts after acquisition,
 * so it emits only the `materialize:*` / `scan:start` events, never `acquire:start`/`target:done`.
 */
export type ProgressEvent =
	| { type: 'acquire:start'; target: string }
	| { type: 'materialize:start'; target: string; total: number }
	| { type: 'materialize:progress'; target: string; done: number; total: number }
	| { type: 'scan:start'; target: string; surface: 'types' | 'runtime' }
	| { type: 'target:done'; target: string };

/** A best-effort progress sink. Implementations MUST NOT throw — see {@link emit}. */
export type ProgressReporter = (event: ProgressEvent) => void;

/**
 * Delivers `event` to `reporter` (if any), swallowing any throw. Progress is decorative —
 * a misbehaving sink must never abort an audit, so the core always emits through this.
 */
export function emit(reporter: ProgressReporter | undefined, event: ProgressEvent): void {
	if (reporter === undefined) {
		return;
	}
	try {
		reporter(event);
	} catch {
		/* A progress sink is best-effort; never let it break the audit. */
	}
}
