import { describe, expect, it } from 'vitest';
import type { DeclaredDependency } from '../src/manifest.ts';
import { materializeDeps } from '../src/resolve.ts';
import type { RegistryProvider } from '../src/types.ts';

/** A provider that records the peak number of simultaneous `materialize` calls. */
function peakTrackingProvider(): { provider: RegistryProvider; peak: () => number } {
	let active = 0;
	let peak = 0;
	return {
		peak: () => peak,
		provider: {
			async materialize() {
				active += 1;
				peak = Math.max(peak, active);
				await new Promise((settle) => setTimeout(settle, 5));
				active -= 1;
				return '1.0.0';
			},
		},
	};
}

function deps(count: number): DeclaredDependency[] {
	return Array.from({ length: count }, (_, i) => ({ name: `dep-${i}`, range: '^1' }));
}

describe('materializeDeps concurrency', () => {
	it('serializes when the cap is 1 (no two materializations overlap)', async () => {
		const { provider, peak } = peakTrackingProvider();
		await materializeDeps(deps(8), provider, '/work', undefined, 1);
		expect(peak()).toBe(1);
	});

	it('honors an explicit cap above 1', async () => {
		const { provider, peak } = peakTrackingProvider();
		await materializeDeps(deps(20), provider, '/work', undefined, 4);
		expect(peak()).toBeLessThanOrEqual(4);
		// With 20 deps and a 4-wide pool the cap is actually reached, not just respected.
		expect(peak()).toBe(4);
	});

	it('defaults to 12 when no cap is given', async () => {
		const { provider, peak } = peakTrackingProvider();
		await materializeDeps(deps(30), provider, '/work');
		expect(peak()).toBe(12);
	});
});
