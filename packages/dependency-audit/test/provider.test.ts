import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPacoteProvider } from '../src/provider.ts';
import { buildWorkspaceIndex } from '../src/workspace.ts';

const temps: string[] = [];
afterEach(() => {
	for (const dir of temps.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), 'da-ws-'));
	temps.push(dir);
	return dir;
}

function writePkg(dir: string, json: Record<string, unknown>): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'package.json'), JSON.stringify(json));
}

/** A workspace root + a `@fix/lib` (v2.3.4) and `@fix/consumer` under packages/. */
function makeWorkspace(kind: 'pnpm' | 'npm'): { root: string; consumer: string; lib: string } {
	const root = tempRoot();
	if (kind === 'pnpm') {
		writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
	} else {
		writePkg(root, { name: 'root', private: true, workspaces: ['packages/*'] });
	}
	const lib = join(root, 'packages', 'lib');
	const consumer = join(root, 'packages', 'consumer');
	writePkg(lib, { name: '@fix/lib', version: '2.3.4', main: './index.js' });
	writeFileSync(join(lib, 'index.js'), 'module.exports = {};\n');
	writePkg(consumer, { name: '@fix/consumer', version: '1.0.0' });
	return { root, consumer, lib };
}

describe('buildWorkspaceIndex', () => {
	it('indexes pnpm workspace packages by name (walking up from a package)', () => {
		const { consumer, lib } = makeWorkspace('pnpm');
		const index = buildWorkspaceIndex(consumer);
		expect(realpathSync(index?.get('@fix/lib') ?? '')).toBe(realpathSync(lib));
		expect(index?.has('@fix/consumer')).toBe(true);
	});

	it('indexes npm `workspaces` packages too', () => {
		const { consumer, lib } = makeWorkspace('npm');
		const index = buildWorkspaceIndex(consumer);
		expect(realpathSync(index?.get('@fix/lib') ?? '')).toBe(realpathSync(lib));
	});

	it('returns undefined when there is no workspace root', () => {
		expect(buildWorkspaceIndex(tempRoot())).toBeUndefined();
	});

	it('parses the pnpm flow-list `packages: [..]` form', () => {
		const root = tempRoot();
		writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages: ['packages/*']\n");
		writePkg(join(root, 'packages', 'lib'), { name: '@fix/lib', version: '2.3.4' });
		expect(buildWorkspaceIndex(join(root, 'packages', 'lib'))?.has('@fix/lib')).toBe(true);
	});
});

describe('createPacoteProvider local materialization', () => {
	it('materializes a workspace: dep by linking the local package', async () => {
		const { consumer, lib } = makeWorkspace('pnpm');
		const into = tempRoot();
		const provider = createPacoteProvider({ where: consumer });
		const version = await provider.materialize('@fix/lib', 'workspace:*', into);
		expect(version).toBe('2.3.4');
		expect(realpathSync(join(into, 'node_modules', '@fix/lib'))).toBe(realpathSync(lib));
	});

	it('materializes a file: dep by linking the resolved local directory', async () => {
		const { consumer, lib } = makeWorkspace('pnpm');
		const into = tempRoot();
		const provider = createPacoteProvider({ where: consumer });
		// consumer is .../packages/consumer; the sibling lib is ../lib
		const version = await provider.materialize('@fix/lib', 'file:../lib', into);
		expect(version).toBe('2.3.4');
		expect(realpathSync(join(into, 'node_modules', '@fix/lib'))).toBe(realpathSync(lib));
	});

	it('resolves a workspace: alias (`workspace:realname@*`) to the aliased package', async () => {
		const { consumer, lib } = makeWorkspace('pnpm');
		const into = tempRoot();
		const provider = createPacoteProvider({ where: consumer });
		// Dependency key "aliased" points at the real package @fix/lib via an alias body.
		const version = await provider.materialize('aliased', 'workspace:@fix/lib@*', into);
		expect(version).toBe('2.3.4');
		expect(realpathSync(join(into, 'node_modules', 'aliased'))).toBe(realpathSync(lib));
	});

	it('returns undefined for a workspace: dep with no resolvable workspace', async () => {
		const into = tempRoot();
		const provider = createPacoteProvider({ where: tempRoot() });
		expect(await provider.materialize('@fix/missing', 'workspace:*', into)).toBeUndefined();
	});

	it('returns undefined (no throw) for a file: dep whose path does not exist', async () => {
		// A local spec fails deterministically, so it degrades to absence — never an error
		// that fails the whole target, and never retried.
		const into = tempRoot();
		const provider = createPacoteProvider({ where: tempRoot() });
		expect(await provider.materialize('gone', 'file:./does-not-exist', into)).toBeUndefined();
	});
});
