import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create } from 'tar';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtractLimitError, extractTarball } from '../src/extract.ts';

const here = dirname(fileURLToPath(import.meta.url));
const leftpadDir = join(here, 'fixtures', 'deps', 'leftpad');
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'da-extract-'));
	tempDirs.push(dir);
	return dir;
}

/** Packs files (under a `package/` prefix, like npm) into a gzipped tarball buffer. */
async function packTarball(): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	const stream = create({ gzip: true, cwd: leftpadDir, prefix: 'package' }, [
		'package.json',
		'index.js',
	]);
	for await (const chunk of stream) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

describe('extractTarball', () => {
	it('extracts a tarball, stripping the leading package/ directory', async () => {
		const buf = await packTarball();
		const dest = tempDir();
		await extractTarball(buf, dest);
		expect(existsSync(join(dest, 'package.json'))).toBe(true);
		expect(readFileSync(join(dest, 'index.js'), 'utf8')).toContain('leftpad');
	});

	it('creates a not-yet-existing nested dest (as the dep provider does)', async () => {
		const buf = await packTarball();
		const dest = join(tempDir(), 'node_modules', 'leftpad');
		await extractTarball(buf, dest);
		expect(existsSync(join(dest, 'package.json'))).toBe(true);
	});

	it('aborts when the byte cap is exceeded (decompression-bomb guard)', async () => {
		const buf = await packTarball();
		await expect(
			extractTarball(buf, tempDir(), { maxBytes: 1, maxEntries: 100_000 }),
		).rejects.toBeInstanceOf(ExtractLimitError);
	});

	it('aborts when the entry cap is exceeded', async () => {
		const buf = await packTarball();
		await expect(
			extractTarball(buf, tempDir(), { maxBytes: 1_000_000_000, maxEntries: 0 }),
		).rejects.toThrow(/decompression bomb/);
	});
});
