const MINUTE_MS = 60_000;

/** Primary requests kept unspent so reads after the refresh never fail on an exhausted window. */
export const DEFAULT_PRIMARY_RESERVE = 50;

export interface WriteBudgetOptions {
	maxWritesPerRun: number;
	maxWritesPerMinute: number;
	primaryReserve?: number;
	now?: () => number;
}

export type BudgetDecision =
	| { ok: true; waitMs: number }
	| { ok: false; reason: 'write-cap' | 'primary-budget' };

export interface WriteBudget {
	/** Whether the next write may proceed, and how long to wait first for the per-minute window. */
	next(primaryRemaining: number | null): BudgetDecision;
	/** Records a write at the current time. */
	record(): void;
	readonly writes: number;
}

/**
 * Pure write pacing: a per-run cap, a sliding per-minute window and a reserve on the primary limit.
 * Secondary limits are not exposed in headers, so the per-minute cap is a conservative heuristic.
 */
export function createWriteBudget(options: WriteBudgetOptions): WriteBudget {
	const now = options.now ?? Date.now;
	const reserve = options.primaryReserve ?? DEFAULT_PRIMARY_RESERVE;
	const recent: number[] = [];
	let writes = 0;
	return {
		get writes() {
			return writes;
		},
		next(primaryRemaining) {
			if (writes >= options.maxWritesPerRun) {
				return { ok: false, reason: 'write-cap' };
			}
			if (primaryRemaining !== null && primaryRemaining <= reserve) {
				return { ok: false, reason: 'primary-budget' };
			}
			const time = now();
			while (recent.length > 0 && (recent[0] as number) <= time - MINUTE_MS) {
				recent.shift();
			}
			if (recent.length < options.maxWritesPerMinute) {
				return { ok: true, waitMs: 0 };
			}
			return { ok: true, waitMs: Math.max(0, (recent[0] as number) + MINUTE_MS - time) };
		},
		record() {
			writes++;
			recent.push(now());
		},
	};
}
