import { Buffer } from 'node:buffer';
import { mkdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extract as tarExtract, type ReadEntry } from 'tar';
import type { ExtractLimits } from './types.ts';

/**
 * Default extraction caps. Registry tarballs are already size-bounded by npm; these guard
 * against a hostile `.tgz`/URL whose small compressed payload expands without limit.
 */
export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
	maxBytes: 512 * 1024 * 1024,
	maxEntries: 100_000,
};

/** Raised when a tarball exceeds the extraction caps (a possible decompression bomb). */
export class ExtractLimitError extends Error {
	constructor(limits: ExtractLimits) {
		super(
			`Tarball exceeds extraction limit (max ${limits.maxBytes} bytes / ` +
				`${limits.maxEntries} entries) — possible decompression bomb.`,
		);
		this.name = 'ExtractLimitError';
	}
}

/**
 * Extracts an npm tarball buffer into `dest` with a streaming guard. Symlink/hardlink
 * entries are skipped (they can't escape, matching pacote's own extraction) and node-tar
 * blocks path traversal by default; once the cumulative declared size or entry count
 * exceeds the caps, remaining entries are skipped and the call throws so a bomb can't run
 * the disk dry. The leading `package/` directory is stripped.
 */
export async function extractTarball(
	tarball: Uint8Array,
	dest: string,
	limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS,
): Promise<void> {
	let entries = 0;
	let bytes = 0;
	let exceeded = false;

	// tar creates entry subdirectories but not the cwd itself; ensure it exists.
	mkdirSync(dest, { recursive: true });
	const sink = tarExtract({
		cwd: dest,
		strip: 1,
		filter: (_path, raw) => {
			// During extraction the entry is always a ReadEntry (the union also covers the
			// create case). Skip symlink/hardlink entries — they cannot escape the root.
			const entry = raw as ReadEntry;
			if (entry.type.endsWith('Link')) {
				return false;
			}
			entries += 1;
			// Counted from the header, before the body is read — so on breach we abort the
			// stream and a bomb's payload is never decompressed (not merely left unwritten).
			bytes += entry.size ?? 0;
			if (entries > limits.maxEntries || bytes > limits.maxBytes) {
				exceeded = true;
				sink.abort(new ExtractLimitError(limits));
				return false;
			}
			return true;
		},
	});

	await pipeline(Readable.from(Buffer.from(tarball)), sink);
	// Belt and suspenders: destroy() rejects the pipeline above; this covers any path
	// where the stream still drains cleanly after a breach.
	if (exceeded) {
		throw new ExtractLimitError(limits);
	}
}
