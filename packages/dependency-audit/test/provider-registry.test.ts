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
vi.mock('pacote', () => ({ default: { tarball: vi.fn() } }));
vi.mock('../src/extract.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/extract.ts')>()),
	extractTarball: vi.fn(),
}));

const tarballMock = vi.mocked(pacote.tarball);
const extractMock = vi.mocked(extractTarball);

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
