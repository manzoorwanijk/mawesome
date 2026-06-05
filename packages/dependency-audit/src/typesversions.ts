/**
 * Minimal `typesVersions` support for the target's own type-entry discovery (current TS
 * version only — the multi-consumer-version matrix is deferred). Resolution of a *dependency's*
 * typesVersions is handled by TypeScript's own resolver; this only models how the package
 * being audited redirects where its declarations live.
 */

/** The active `typesVersions` mapping for a TS version. */
export interface ActiveTypesVersions {
	/** `true` when the mapping has a `"*"` catch-all key — it then governs the whole surface. */
	catchAll: boolean;
	/** Target patterns the mapping points at (e.g. `dist/*`), relative to the package root. */
	targets: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Returns the first `typesVersions` mapping whose version range matches `tsVersion`
 * (TypeScript picks the first match), or `undefined` if none applies.
 */
export function activeTypesVersions(
	typesVersions: unknown,
	tsVersion: string,
): ActiveTypesVersions | undefined {
	if (!isRecord(typesVersions)) {
		return undefined;
	}
	for (const [range, mapping] of Object.entries(typesVersions)) {
		if (!satisfiesTypesVersion(tsVersion, range)) {
			continue;
		}
		// First-match wins (TS semantics): a matching range with a malformed mapping yields
		// no usable typesVersions, rather than letting a later range take over.
		if (!isRecord(mapping)) {
			return undefined;
		}
		const targets: string[] = [];
		let catchAll = false;
		for (const [key, value] of Object.entries(mapping)) {
			if (key === '*') {
				catchAll = true;
			}
			if (Array.isArray(value)) {
				for (const target of value) {
					if (typeof target === 'string') {
						targets.push(target);
					}
				}
			}
		}
		return { catchAll, targets };
	}
	return undefined;
}

/** `true` if `version` satisfies a `typesVersions` range key (`*`, `>=4.0`, `<5.0`, `4.5`…). */
function satisfiesTypesVersion(version: string, range: string): boolean {
	const trimmed = range.trim();
	if (trimmed === '*' || trimmed === '') {
		return true;
	}
	const parsed = parseVersion(version);
	if (parsed === undefined) {
		return false;
	}
	return trimmed.split(/\s+/).every((comparator) => satisfiesComparator(parsed, comparator));
}

function satisfiesComparator(version: [number, number, number], comparator: string): boolean {
	// End-anchored so a malformed comparator (e.g. `>=4.0junk`) fails rather than matching
	// its valid prefix and wrongly activating a mapping.
	const match = /^(>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(comparator);
	if (match === null) {
		return false;
	}
	const op = match[1] ?? '=';
	const major = Number(match[2]);
	const minorRaw = match[3];
	const patchRaw = match[4];
	const target: [number, number, number] = [major, Number(minorRaw ?? 0), Number(patchRaw ?? 0)];
	const cmp = compareVersions(version, target);
	switch (op) {
		case '>=':
			return cmp >= 0;
		case '<=':
			return cmp <= 0;
		case '>':
			return cmp > 0;
		case '<':
			return cmp < 0;
		default:
			// A bare version is a prefix range: `4` → any 4.x, `4.5` → any 4.5.x.
			if (minorRaw === undefined) {
				return version[0] === major;
			}
			if (patchRaw === undefined) {
				return version[0] === major && version[1] === target[1];
			}
			return cmp === 0;
	}
}

function parseVersion(version: string): [number, number, number] | undefined {
	const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
	if (match === null) {
		return undefined;
	}
	return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
	for (let i = 0; i < 3; i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) {
			return diff < 0 ? -1 : 1;
		}
	}
	return 0;
}
