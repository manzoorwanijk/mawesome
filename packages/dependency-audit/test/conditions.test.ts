import { cpSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { audit, type RegistryProvider } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const depsRoot = join(here, 'fixtures', 'deps');
const targetsRoot = join(here, 'fixtures', 'targets');

const fixtureProvider: RegistryProvider = {
	async materialize(name, _range, intoDir) {
		const src = join(depsRoot, name);
		if (!existsSync(src)) {
			return undefined;
		}
		cpSync(src, join(intoDir, 'node_modules', name), { recursive: true });
		const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')) as { version?: string };
		return pkg.version;
	},
};

const run = (name: string, conditions?: readonly string[]) =>
	audit(
		join(targetsRoot, name),
		conditions === undefined
			? { provider: fixtureProvider }
			: { conditions, provider: fixtureProvider },
	);

const pkgs = (result: Awaited<ReturnType<typeof audit>>) =>
	new Set(result.findings.map((f) => f.packageName));

describe('audit (resolution conditions)', () => {
	it('audits the default condition surface when none is requested', async () => {
		const found = pkgs(await run('browser-condition'));
		// Default profile: `index.js` (runtime) and `index.d.ts` (types).
		expect(found.has('node-runtime-dep')).toBe(true);
		expect(found.has('node-types-dep')).toBe(true);
		// The browser-only surfaces are not reachable without `--condition browser`.
		expect(found.has('browser-runtime-dep')).toBe(false);
		expect(found.has('browser-types-dep')).toBe(false);
	});

	it('switches to the browser surface under `--condition browser`', async () => {
		const found = pkgs(await run('browser-condition', ['browser']));
		// The browser condition wins for both the runtime and type entry points.
		expect(found.has('browser-runtime-dep')).toBe(true);
		expect(found.has('browser-types-dep')).toBe(true);
		expect(found.has('node-runtime-dep')).toBe(false);
		expect(found.has('node-types-dep')).toBe(false);
	});

	it('resolves a declared dep that only exports under the browser condition', async () => {
		// `cond-dep` exposes `.` (runtime + types) *only* under the `browser`
		// condition, so the resolver must pass the active conditions through —
		// both the TS `customConditions` and the resolve.exports path.
		const found = pkgs(await run('browser-condition', ['browser']));
		expect(found.has('cond-dep')).toBe(false);
	});
});
