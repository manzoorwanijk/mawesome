import { describe, expect, it } from 'vitest';
import { createWriteBudget, DEFAULT_PRIMARY_RESERVE } from '../../src/budget.ts';

describe('createWriteBudget', () => {
	it('stops at the per-run cap', () => {
		const budget = createWriteBudget({ maxWritesPerRun: 2, maxWritesPerMinute: 10, now: () => 0 });
		expect(budget.next(null)).toEqual({ ok: true, waitMs: 0 });
		budget.record();
		budget.record();
		expect(budget.next(null)).toEqual({ ok: false, reason: 'write-cap' });
		expect(budget.writes).toBe(2);
	});

	it('keeps a reserve on the primary limit', () => {
		const budget = createWriteBudget({ maxWritesPerRun: 10, maxWritesPerMinute: 10, now: () => 0 });
		expect(budget.next(DEFAULT_PRIMARY_RESERVE + 1)).toEqual({ ok: true, waitMs: 0 });
		expect(budget.next(DEFAULT_PRIMARY_RESERVE)).toEqual({ ok: false, reason: 'primary-budget' });
		expect(budget.next(0)).toEqual({ ok: false, reason: 'primary-budget' });
	});

	it('paces writes over a sliding minute', () => {
		let now = 0;
		const budget = createWriteBudget({
			maxWritesPerRun: 100,
			maxWritesPerMinute: 2,
			now: () => now,
		});
		budget.record();
		now = 10_000;
		budget.record();
		expect(budget.next(null)).toEqual({ ok: true, waitMs: 50_000 });
		now = 60_000;
		expect(budget.next(null)).toEqual({ ok: true, waitMs: 0 });
		budget.record();
		expect(budget.next(null)).toEqual({ ok: true, waitMs: 10_000 });
	});
});
