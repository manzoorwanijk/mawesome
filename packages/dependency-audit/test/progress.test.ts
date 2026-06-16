import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { audit } from '../src/audit.ts';
import {
	auditPackage,
	createMemoryFileSystem,
	type ProgressEvent,
	type RegistryProvider,
	type WritableFileSystem,
} from '../src/browser.ts';
import { createTtyReporter } from '../src/progress-tty.ts';

const here = dirname(fileURLToPath(import.meta.url));
const okTarget = join(here, 'fixtures', 'targets', 'require-forms');

/* ── Core: the events `auditPackage`/`audit` emit ─────────────────────────────────── */

const DEP_FILES: Record<string, Record<string, string>> = {
	csstype: {
		'package.json': JSON.stringify({ name: 'csstype', version: '3.1.3', types: './index.d.ts' }),
		'index.d.ts': 'export interface Properties { color?: string }\n',
	},
};

function memoryProvider(fs: WritableFileSystem): RegistryProvider {
	return {
		async materialize(name, _range, intoDir) {
			const files = DEP_FILES[name];
			if (files === undefined) {
				return undefined;
			}
			for (const [rel, content] of Object.entries(files)) {
				fs.writeFile(`${intoDir}/node_modules/${name}/${rel}`, content);
			}
			return '3.1.3';
		},
	};
}

function seed(fs: WritableFileSystem, deps: Record<string, string>): void {
	fs.writeFile(
		'/pkg/package.json',
		JSON.stringify({ name: '@demo/pkg', version: '1.0.0', type: 'module', dependencies: deps }),
	);
	fs.writeFile('/pkg/index.d.ts', "import type { Properties } from 'csstype';\n");
	fs.writeFile('/pkg/index.js', 'export const y = 1;\n');
}

/*
 * These drive the core over the in-memory FS (the browser path, where `node:path` is path-browserify
 * / POSIX). On Windows-Node the core's win32 `node:path` joins diverge from the POSIX-keyed tree — a
 * config that never ships (the CLI uses the real Node FS, exercised by `audit` below and cli.test).
 */
describe.skipIf(process.platform === 'win32')('auditPackage progress events', () => {
	it('emits materialize then both scans, with the count reaching the total', async () => {
		const fs = createMemoryFileSystem();
		seed(fs, { csstype: '^3.0.0' });
		const events: ProgressEvent[] = [];

		await auditPackage(fs, '/pkg', {
			provider: memoryProvider(fs),
			workDir: '/work',
			target: '@demo/pkg',
			progress: (event) => events.push(event),
		});

		expect(events).toEqual([
			{ type: 'materialize:start', target: '@demo/pkg', total: 1 },
			{ type: 'materialize:progress', target: '@demo/pkg', done: 1, total: 1 },
			{ type: 'scan:start', target: '@demo/pkg', surface: 'types' },
			{ type: 'scan:start', target: '@demo/pkg', surface: 'runtime' },
		]);
	});

	it('still emits materialize:start (total 0) and the scans for a zero-dependency package', async () => {
		const fs = createMemoryFileSystem();
		seed(fs, {});
		const events: ProgressEvent[] = [];

		await auditPackage(fs, '/pkg', {
			provider: memoryProvider(fs),
			workDir: '/work',
			target: '@demo/pkg',
			progress: (event) => events.push(event),
		});

		expect(events).toEqual([
			{ type: 'materialize:start', target: '@demo/pkg', total: 0 },
			{ type: 'scan:start', target: '@demo/pkg', surface: 'types' },
			{ type: 'scan:start', target: '@demo/pkg', surface: 'runtime' },
		]);
	});

	it('a throwing reporter never breaks the audit', async () => {
		const fs = createMemoryFileSystem();
		seed(fs, {});
		await expect(
			auditPackage(fs, '/pkg', {
				provider: memoryProvider(fs),
				workDir: '/work',
				progress: () => {
					throw new Error('boom');
				},
			}),
		).resolves.toBeDefined();
	});

	it('awaits every dep before throwing when one rejects (count reaches total, no orphan writes)', async () => {
		const fs = createMemoryFileSystem();
		fs.writeFile(
			'/pkg/package.json',
			JSON.stringify({ name: '@d/p', version: '1.0.0', dependencies: { good: '^1', bad: '^1' } }),
		);
		fs.writeFile('/pkg/index.js', 'export const y = 1;\n');
		const events: ProgressEvent[] = [];
		const provider: RegistryProvider = {
			async materialize(name) {
				// `bad` rejects immediately; `good` resolves later. With a fail-fast materialize the
				// audit would throw while `good` is still in flight (last count 1/2); the deferred
				// throw must instead wait for `good`, so the final count is 2/2.
				if (name === 'bad') {
					throw new Error('fetch failed');
				}
				await new Promise((settle) => setTimeout(settle, 10));
				return '1.0.0';
			},
		};

		await expect(
			auditPackage(fs, '/pkg', {
				provider,
				workDir: '/work',
				target: '@d/p',
				progress: (event) => events.push(event),
			}),
		).rejects.toThrow('fetch failed');

		const progress = events.filter((e) => e.type === 'materialize:progress');
		expect(progress.at(-1)).toMatchObject({ done: 2, total: 2 });
	});
});

describe('audit progress events', () => {
	it('opens with acquire:start for a directory target', async () => {
		const events: ProgressEvent[] = [];
		await audit(okTarget, { progress: (event) => events.push(event) });
		expect(events[0]).toEqual({ type: 'acquire:start', target: okTarget });
		// Acquisition is followed by materialization of the (zero) declared deps.
		expect(events[1]).toMatchObject({ type: 'materialize:start' });
	});
});

/* ── Renderer: the stderr TTY reporter ────────────────────────────────────────────── */

/** A fake write stream that records every chunk. */
function fakeStream(isTTY: boolean): {
	isTTY: boolean;
	write(s: string): boolean;
	writes: string[];
} {
	const writes: string[] = [];
	return {
		isTTY,
		write(chunk: string): boolean {
			writes.push(chunk);
			return true;
		},
		writes,
	};
}

/** A manual scheduler: exposes the captured tick callback so a test can advance the spinner. */
function fakeScheduler(): {
	schedule: (cb: () => void) => () => void;
	tick(): void;
	live(): boolean;
} {
	let cb: (() => void) | undefined;
	return {
		schedule(next: () => void): () => void {
			cb = next;
			return () => {
				cb = undefined;
			};
		},
		tick(): void {
			cb?.();
		},
		live(): boolean {
			return cb !== undefined;
		},
	};
}

describe('createTtyReporter', () => {
	it('is a no-op when stderr is not a TTY', () => {
		const stream = fakeStream(false);
		const { reporter, stop } = createTtyReporter({ total: 1, stream, env: {} });
		reporter({ type: 'acquire:start', target: 'x' });
		stop();
		expect(stream.writes).toEqual([]);
	});

	it('is a no-op under TERM=dumb even on a TTY', () => {
		const stream = fakeStream(true);
		const { reporter } = createTtyReporter({ total: 1, stream, env: { TERM: 'dumb' } });
		reporter({ type: 'acquire:start', target: 'x' });
		expect(stream.writes).toEqual([]);
	});

	it('is a no-op when explicitly disabled (--no-progress) on a TTY', () => {
		const stream = fakeStream(true);
		const { reporter } = createTtyReporter({ total: 1, enabled: false, stream, env: {} });
		reporter({ type: 'acquire:start', target: 'x' });
		expect(stream.writes).toEqual([]);
	});

	it('is a no-op under NO_PROGRESS even on a TTY', () => {
		const stream = fakeStream(true);
		const { reporter } = createTtyReporter({ total: 1, stream, env: { NO_PROGRESS: '1' } });
		reporter({ type: 'acquire:start', target: 'x' });
		expect(stream.writes).toEqual([]);
	});

	it('exposes `enabled` mirroring the gate (the CLI uses it to gate the stderr banner)', () => {
		// `enabled` must track the same conditions that silence the spinner — it is what the CLI reads to decide whether to print the version banner.
		const reporter = (env: Record<string, string | undefined>, opts?: { enabled?: boolean }) =>
			createTtyReporter({ total: 1, stream: fakeStream(true), env, ...opts }).enabled;
		expect(reporter({})).toBe(true);
		expect(createTtyReporter({ total: 1, stream: fakeStream(false), env: {} }).enabled).toBe(false);
		expect(reporter({ TERM: 'dumb' })).toBe(false);
		expect(reporter({ NO_PROGRESS: '1' })).toBe(false);
		expect(reporter({}, { enabled: false })).toBe(false);
	});

	it('renders the materialize count for a single target', () => {
		const stream = fakeStream(true);
		const clock = fakeScheduler();
		const { reporter } = createTtyReporter({
			total: 1,
			stream,
			env: {},
			now: () => 0,
			schedule: clock.schedule,
		});
		reporter({ type: 'materialize:start', target: 'x', total: 4 });
		reporter({ type: 'materialize:progress', target: 'x', done: 2, total: 4 });
		const last = stream.writes.at(-1) ?? '';
		expect(last).toContain('materializing deps 2/4');
	});

	it('renders an X/N headline for multiple targets', () => {
		const stream = fakeStream(true);
		const { reporter } = createTtyReporter({
			total: 2,
			stream,
			env: {},
			now: () => 0,
			schedule: fakeScheduler().schedule,
		});
		reporter({ type: 'materialize:start', target: 'a', total: 3 });
		reporter({ type: 'materialize:start', target: 'b', total: 1 });
		const last = stream.writes.at(-1) ?? '';
		expect(last).toContain('auditing 0/2');
		expect(last).toContain('materializing 0/4 deps');
	});

	it('starts the spinner only on the first event and advances it on a tick', () => {
		const stream = fakeStream(true);
		const clock = fakeScheduler();
		const { reporter } = createTtyReporter({
			total: 1,
			stream,
			env: {},
			now: () => 0,
			schedule: clock.schedule,
		});
		expect(clock.live()).toBe(false);
		reporter({ type: 'acquire:start', target: 'x' });
		expect(clock.live()).toBe(true);
		const before = stream.writes.length;
		clock.tick();
		expect(stream.writes.length).toBeGreaterThan(before);
	});

	it('clear() erases the line without ending the spinner', () => {
		const stream = fakeStream(true);
		const clock = fakeScheduler();
		const { reporter, clear } = createTtyReporter({
			total: 1,
			stream,
			env: {},
			now: () => 0,
			schedule: clock.schedule,
		});
		reporter({ type: 'acquire:start', target: 'x' });
		const before = stream.writes.length;
		clear();
		// readline erases via cursorTo(0) + clearLine(0); no content is written after.
		expect(stream.writes.slice(before)).toEqual(['\x1b[1G', '\x1b[2K']);
		expect(clock.live()).toBe(true);
	});

	it('stop() is idempotent, ends the spinner, and ignores later events', () => {
		const stream = fakeStream(true);
		const clock = fakeScheduler();
		const { reporter, stop } = createTtyReporter({
			total: 1,
			stream,
			env: {},
			now: () => 0,
			schedule: clock.schedule,
		});
		reporter({ type: 'acquire:start', target: 'x' });
		stop();
		stop();
		expect(clock.live()).toBe(false);
		const after = stream.writes.length;
		reporter({ type: 'materialize:start', target: 'x', total: 1 });
		expect(stream.writes.length).toBe(after);
	});

	it('ignores a late event for an already-finished target (no resurrection)', () => {
		const stream = fakeStream(true);
		const { reporter } = createTtyReporter({
			total: 1,
			stream,
			env: {},
			now: () => 0,
			schedule: fakeScheduler().schedule,
		});
		reporter({ type: 'materialize:start', target: 'x', total: 2 });
		reporter({ type: 'target:done', target: 'x' });
		const before = stream.writes.length;
		// A straggler dep settling after the target failed must not redraw or re-add it.
		reporter({ type: 'materialize:progress', target: 'x', done: 2, total: 2 });
		expect(stream.writes.length).toBe(before);
	});

	it('disables itself without throwing when a write fails', () => {
		let calls = 0;
		const stream = {
			isTTY: true,
			write(): boolean {
				calls++;
				throw new Error('EPIPE');
			},
		};
		const clock = fakeScheduler();
		const { reporter, stop } = createTtyReporter({
			total: 1,
			stream,
			env: {},
			now: () => 0,
			schedule: clock.schedule,
		});
		expect(() => reporter({ type: 'acquire:start', target: 'x' })).not.toThrow();
		// A failed write disables the spinner: its timer is cancelled and later events are no-ops.
		expect(clock.live()).toBe(false);
		const after = calls;
		reporter({ type: 'materialize:start', target: 'x', total: 1 });
		expect(calls).toBe(after);
		expect(() => stop()).not.toThrow();
	});

	it('disables itself without throwing when the scheduler throws', () => {
		const stream = fakeStream(true);
		const { reporter, stop } = createTtyReporter({
			total: 1,
			stream,
			env: {},
			now: () => 0,
			schedule: () => {
				throw new Error('cannot schedule');
			},
		});
		// A throwing scheduler must be swallowed (progress is decorative), not abort the caller.
		expect(() => reporter({ type: 'acquire:start', target: 'x' })).not.toThrow();
		const after = stream.writes.length;
		reporter({ type: 'materialize:start', target: 'x', total: 1 });
		expect(stream.writes.length).toBe(after);
		expect(() => stop()).not.toThrow();
	});

	it('omits ANSI styling under NO_COLOR but still renders', () => {
		const stream = fakeStream(true);
		const { reporter } = createTtyReporter({
			total: 1,
			stream,
			env: { NO_COLOR: '1' },
			now: () => 0,
			schedule: fakeScheduler().schedule,
		});
		reporter({ type: 'materialize:start', target: 'x', total: 1 });
		const last = stream.writes.at(-1) ?? '';
		expect(last).toContain('materializing');
		expect(last).not.toContain('\x1b[2m');
	});
});
