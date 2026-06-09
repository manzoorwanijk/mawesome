import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pacote from 'pacote';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtractLimitError, extractTarball } from '../src/extract.ts';
import { createPacoteProvider } from '../src/provider.ts';

/*
 * The registry branch is the only one that touches the network, so it is mocked: `pacote.tarball`
 * is controllable per-call (fail N times, then succeed) and `extractTarball` writes a minimal
 * `package.json` so `readVersion` has something to read. This exercises the retry/rethrow logic
 * without a real fetch — the extraction itself is covered by extract.test.ts.
 */
vi.mock('pacote', () => ({ default: { tarball: vi.fn(), packument: vi.fn() } }));
vi.mock('../src/extract.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/extract.ts')>()),
	extractTarball: vi.fn(),
}));

const tarballMock = vi.mocked(pacote.tarball);
const packumentMock = vi.mocked(pacote.packument);
const extractMock = vi.mocked(extractTarball);

// packument's resolved value is never inspected (only that it resolves), so a bare object stands in.
const FAKE_PACKUMENT = {} as Awaited<ReturnType<typeof pacote.packument>>;

/** A registry error shaped like npm-registry-fetch's "not found". */
const notFound = (): Error => Object.assign(new Error('404 Not Found'), { statusCode: 404 });

// pacote.tarball resolves to `Buffer & FetchResult`; the bytes are never read here (extract is
// mocked), so a bare buffer stands in — cast to the real resolved type so it tracks any drift.
const FAKE_TARBALL = Buffer.from([]) as Awaited<ReturnType<typeof pacote.tarball>>;

const temps: string[] = [];
afterEach(() => {
	for (const dir of temps.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	vi.clearAllMocks();
});

function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), 'da-reg-'));
	temps.push(dir);
	return dir;
}

/** Makes the extract mock drop a `package.json@version` into the destination, as a real extract would. */
function extractWrites(version: string): void {
	extractMock.mockImplementation((_tarball, dest) => {
		mkdirSync(dest, { recursive: true });
		writeFileSync(join(dest, 'package.json'), JSON.stringify({ version }));
		return Promise.resolve();
	});
}

describe('createPacoteProvider — registry fault tolerance', () => {
	beforeEach(() => {
		tarballMock.mockResolvedValue(FAKE_TARBALL);
		extractWrites('1.2.3');
	});

	it('retries a transient registry failure and self-heals', async () => {
		tarballMock
			.mockRejectedValueOnce(new Error('ETIMEDOUT'))
			.mockRejectedValueOnce(new Error('socket hang up'))
			.mockResolvedValueOnce(FAKE_TARBALL);

		const provider = createPacoteProvider({ retries: 3 });
		const version = await provider.materialize('foo', '^1', tempRoot());

		expect(version).toBe('1.2.3');
		expect(tarballMock).toHaveBeenCalledTimes(3);
	});

	it('throws after exhausting retries, naming the dep', async () => {
		tarballMock.mockReset();
		tarballMock.mockRejectedValue(new Error('ETIMEDOUT'));

		const provider = createPacoteProvider({ retries: 1 });
		await expect(provider.materialize('foo', '^1', tempRoot())).rejects.toThrow(
			/Failed to materialize foo@\^1: ETIMEDOUT/,
		);
		// 1 initial + 1 retry.
		expect(tarballMock).toHaveBeenCalledTimes(2);
	});

	it('does not retry an ExtractLimitError (decompression-bomb guard)', async () => {
		extractMock.mockReset();
		extractMock.mockRejectedValue(new ExtractLimitError({ maxBytes: 1, maxEntries: 1 }));

		const provider = createPacoteProvider({ retries: 3 });
		await expect(provider.materialize('foo', '^1', tempRoot())).rejects.toThrow(
			/possible decompression bomb/,
		);
		// Aborted on the first attempt — never retried.
		expect(tarballMock).toHaveBeenCalledTimes(1);
	});
});

describe('createPacoteProvider — packageExists probe', () => {
	// Distinct package names per test sidestep the process-wide existence cache.
	it('reports a resolvable package as exists', async () => {
		packumentMock.mockResolvedValueOnce(FAKE_PACKUMENT);
		expect(await createPacoteProvider().packageExists?.('exists-pkg')).toBe('exists');
	});

	it('reports a 404 as absent', async () => {
		packumentMock.mockRejectedValueOnce(notFound());
		expect(await createPacoteProvider().packageExists?.('absent-pkg')).toBe('absent');
	});

	it('reports any other failure as unknown, and does not cache it', async () => {
		packumentMock
			.mockRejectedValueOnce(new Error('ETIMEDOUT'))
			.mockResolvedValueOnce(FAKE_PACKUMENT);
		const provider = createPacoteProvider();
		expect(await provider.packageExists?.('flaky-pkg')).toBe('unknown');
		// `unknown` is evicted from the cache, so a later probe re-fetches and can succeed.
		expect(await provider.packageExists?.('flaky-pkg')).toBe('exists');
		expect(packumentMock).toHaveBeenCalledTimes(2);
	});

	it('dedups concurrent probes for the same package', async () => {
		packumentMock.mockResolvedValueOnce(FAKE_PACKUMENT);
		const provider = createPacoteProvider();
		const both = await Promise.all([
			provider.packageExists?.('dedup-pkg'),
			provider.packageExists?.('dedup-pkg'),
		]);
		expect(both).toEqual(['exists', 'exists']);
		expect(packumentMock).toHaveBeenCalledTimes(1);
	});

	it('keys the cache by `where`, so a different registry config re-probes', async () => {
		packumentMock.mockResolvedValue(FAKE_PACKUMENT);
		await createPacoteProvider({ where: '/reg-a' }).packageExists?.('wk-pkg');
		await createPacoteProvider({ where: '/reg-b' }).packageExists?.('wk-pkg');
		expect(packumentMock).toHaveBeenCalledTimes(2);
	});
});
