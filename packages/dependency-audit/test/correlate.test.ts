import { describe, expect, it } from 'vitest';
import { correlateRootCauses, isCollapsed, resultFails } from '../src/correlate.ts';
import type { AuditResult, Finding, NoticeKind } from '../src/types.ts';

const finding = (over: Partial<Finding> = {}): Finding => ({
	specifier: 'x',
	packageName: 'x',
	surface: 'types',
	kind: 'missing-types',
	firstSeenIn: 'index.d.ts',
	suggestion: '…',
	...over,
});

const result = (over: Partial<AuditResult> = {}): AuditResult => {
	const merged: AuditResult = {
		target: over.packageName ?? 'pkg',
		source: { kind: 'directory' },
		packageName: 'pkg',
		packageVersion: '1.0.0',
		ok: true,
		findings: [],
		ignored: [],
		unchecked: [],
		notices: [],
		resolvedDeps: [],
		...over,
	};
	// Keep `ok` consistent with the AuditResult contract (false when findings remain) unless set.
	return { ...merged, ok: over.ok ?? merged.findings.length === 0 };
};

const notice = (kind: NoticeKind): AuditResult['notices'][number] => ({
	kind,
	surface: 'types',
	message: '…',
});

describe('correlateRootCauses', () => {
	it('annotates a consumer finding whose package is a producer target with a coverage notice', () => {
		const consumer = result({
			packageName: 'consumer',
			findings: [finding({ packageName: 'producer', specifier: 'producer' })],
		});
		const producer = result({
			packageName: 'producer',
			target: './packages/producer',
			notices: [notice('types-unreachable')],
		});

		correlateRootCauses([consumer, producer]);

		expect(consumer.findings[0]?.causedBy).toEqual({
			target: './packages/producer',
			packageName: 'producer',
			notice: 'types-unreachable',
		});
	});

	it('annotates a types-unavailable finding too (still a "declared but unresolved types" gap)', () => {
		const consumer = result({
			packageName: 'consumer',
			findings: [
				finding({ packageName: 'producer', specifier: 'producer', kind: 'types-unavailable' }),
			],
		});
		const producer = result({ packageName: 'producer', notices: [notice('types-unreachable')] });

		correlateRootCauses([consumer, producer]);

		expect(consumer.findings[0]?.causedBy?.notice).toBe('types-unreachable');
	});

	it("never annotates an undeclared finding (that is a consumer-side gap, not the producer's)", () => {
		const consumer = result({
			packageName: 'consumer',
			findings: [finding({ packageName: 'producer', specifier: 'producer', kind: 'undeclared' })],
		});
		const producer = result({ packageName: 'producer', notices: [notice('types-unreachable')] });

		correlateRootCauses([consumer, producer]);

		expect(consumer.findings[0]?.causedBy).toBeUndefined();
	});

	it('records the first producer when two targets share a package name (deterministic)', () => {
		const consumer = result({
			packageName: 'consumer',
			findings: [finding({ packageName: 'dup', specifier: 'dup' })],
		});
		const first = result({
			packageName: 'dup',
			target: './a',
			notices: [notice('types-unreachable')],
		});
		const second = result({
			packageName: 'dup',
			target: './b',
			notices: [notice('types-not-built')],
		});

		correlateRootCauses([consumer, first, second]);

		expect(consumer.findings[0]?.causedBy).toEqual({
			target: './a',
			packageName: 'dup',
			notice: 'types-unreachable',
		});
	});

	it('does not annotate when the package has no coverage notice in the run', () => {
		const consumer = result({
			packageName: 'consumer',
			findings: [finding({ packageName: 'producer', specifier: 'producer' })],
		});
		// `producer` is a target but ships clean (no notice).
		const producer = result({ packageName: 'producer' });

		correlateRootCauses([consumer, producer]);

		expect(consumer.findings[0]?.causedBy).toBeUndefined();
	});

	it('does not annotate a non-correlatable kind (a runtime unresolved finding is left alone)', () => {
		const consumer = result({
			packageName: 'consumer',
			findings: [
				finding({
					packageName: 'producer',
					specifier: 'producer/sub',
					surface: 'runtime',
					kind: 'unresolved',
				}),
			],
		});
		const producer = result({ packageName: 'producer', notices: [notice('types-not-built')] });

		correlateRootCauses([consumer, producer]);

		expect(consumer.findings[0]?.causedBy).toBeUndefined();
	});

	it('never self-attributes and leaves findings for non-producers untouched', () => {
		const producer = result({
			packageName: 'producer',
			notices: [notice('types-unreachable')],
			// A finding (for some other package) inside the producer's own result must not be annotated by itself.
			findings: [
				finding({ packageName: 'producer', specifier: 'producer' }),
				finding({ packageName: 'lodash' }),
			],
		});

		correlateRootCauses([producer]);

		expect(producer.findings.every((f) => f.causedBy === undefined)).toBe(true);
	});

	it('is a no-op when no target carries a notice', () => {
		const a = result({ packageName: 'a', findings: [finding({ packageName: 'b' })] });
		const b = result({ packageName: 'b', findings: [finding({ packageName: 'a' })] });

		correlateRootCauses([a, b]);

		expect(a.findings[0]?.causedBy).toBeUndefined();
		expect(b.findings[0]?.causedBy).toBeUndefined();
	});
});

describe('isCollapsed / resultFails (--collapse-root-cause)', () => {
	const correlated = finding({
		causedBy: { target: './producer', packageName: 'producer', notice: 'types-unreachable' },
	});

	it('isCollapsed needs both the flag and a causedBy annotation', () => {
		expect(isCollapsed(correlated, true)).toBe(true);
		expect(isCollapsed(correlated, false)).toBe(false);
		expect(isCollapsed(finding(), true)).toBe(false);
	});

	it('resultFails drops collapsed findings only when the flag is set', () => {
		const r = result({ findings: [correlated] });
		expect(resultFails(r, false)).toBe(true); // collapse off → a finding still fails
		expect(resultFails(r, true)).toBe(false); // every finding collapsed → passes
	});

	it('resultFails still fails when a non-collapsed finding remains', () => {
		const r = result({ findings: [correlated, finding({ packageName: 'own-bug' })] });
		expect(resultFails(r, true)).toBe(true);
	});

	it('resultFails is false for a result with no findings', () => {
		expect(resultFails(result(), true)).toBe(false);
		expect(resultFails(result(), false)).toBe(false);
	});
});
