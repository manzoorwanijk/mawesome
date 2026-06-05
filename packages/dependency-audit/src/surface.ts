import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import type { FileSystem } from './fs.ts';
import { expandPatternTarget, isWithin } from './fsutil.ts';
import type { Manifest } from './manifest.ts';
import type { UncheckedSpecifier } from './types.ts';

/** How an external requirement was expressed — affects how it is resolved. */
export type SpecifierKind = 'module' | 'type-reference';

/** An external bare specifier and the declaration file it was first seen in. */
export interface ExternalSpecifier {
	specifier: string;
	kind: SpecifierKind;
	/** Package-relative path of the `.d.ts` it appears in. */
	firstSeenIn: string;
}

/** The discovered type surface: scanned files and the specifiers they reference. */
export interface SurfaceScan {
	files: string[];
	externals: ExternalSpecifier[];
	unchecked: UncheckedSpecifier[];
}

const DTS_RE = /\.d\.[mc]?ts$/;

/**
 * The active conditions for the v1 type surface (NodeNext / ESM, `types` first).
 * `require`, `browser`, `development`, `production` are intentionally excluded —
 * the entry surface is profile-driven, never the union of all branches.
 */
const ACTIVE_CONDITIONS = ['import', 'node', 'default'];

/**
 * Scans the package's released type surface: discovers declaration entry points
 * from the manifest, then follows relative imports between `.d.ts` files,
 * collecting every external specifier reachable on the way.
 */
export function scanTypeSurface(fs: FileSystem, root: string, manifest: Manifest): SurfaceScan {
	const externals: ExternalSpecifier[] = [];
	const unchecked: UncheckedSpecifier[] = [];
	const seenExternal = new Set<string>();
	const visited = new Set<string>();
	const queue = [...typeEntryPoints(fs, root, manifest)];

	while (queue.length > 0) {
		const file = queue.shift();
		if (file === undefined || visited.has(file)) {
			continue;
		}
		visited.add(file);
		const rel = relative(root, file);

		for (const ref of specifiersIn(fs, file)) {
			if (ref.kind === 'module' && isRelative(ref.specifier)) {
				const target = resolveRelativeDts(fs, file, ref.specifier, root);
				if (target !== undefined && !visited.has(target)) {
					queue.push(target);
				}
				continue;
			}
			if (ref.dynamic) {
				unchecked.push({ specifier: ref.specifier, reason: 'dynamic specifier', firstSeenIn: rel });
				continue;
			}
			const dedupeKey = `${ref.kind}:${ref.specifier}`;
			if (!seenExternal.has(dedupeKey)) {
				seenExternal.add(dedupeKey);
				externals.push({ specifier: ref.specifier, kind: ref.kind, firstSeenIn: rel });
			}
		}
	}

	return { files: [...visited].map((f) => relative(root, f)), externals, unchecked };
}

/** Discovers absolute paths of the declaration entry points from the manifest. */
function typeEntryPoints(fs: FileSystem, root: string, manifest: Manifest): string[] {
	const found = new Set<string>();
	const addTarget = (target: string | undefined): void => {
		const dts = target === undefined ? undefined : toDeclarationPath(target);
		if (dts !== undefined) {
			const abs = resolve(root, dts);
			if (fs.isFile(abs)) {
				found.add(abs);
			}
		}
	};

	if (manifest.exports !== undefined) {
		// `exports` encapsulates the package: only its (profile-selected) targets are
		// the surface. Legacy `types`/`typings` are ignored when `exports` is present.
		for (const target of exportsTypeTargets(manifest.exports)) {
			expandPatternTarget(fs, root, target).forEach(addTarget);
		}
		return [...found];
	}

	// No `exports`: consumers can deep-import any published declaration file, so the
	// reachable set is every `.d.ts` in the tarball (plus the legacy entry points).
	addTarget(manifest.types);
	addTarget(manifest.typings);
	addTarget(manifest.module);
	addTarget(manifest.main);
	for (const file of allDeclarationFiles(fs, root)) {
		found.add(file);
	}
	return [...found];
}

/** Selects the type-surface target(s) from an `exports` field for the v1 profile. */
function exportsTypeTargets(exportsField: unknown): string[] {
	if (isSubpathMap(exportsField)) {
		const targets: string[] = [];
		for (const value of Object.values(exportsField)) {
			// Pattern subpath keys (`./*`) are included; their target is expanded later.
			const target = selectConditionTarget(value);
			if (target !== undefined) {
				targets.push(target);
			}
		}
		return targets;
	}
	const target = selectConditionTarget(exportsField);
	return target === undefined ? [] : [target];
}

/** `true` when an `exports` value maps subpaths (`"."`, `"./x"`) rather than conditions. */
function isSubpathMap(node: unknown): node is Record<string, unknown> {
	return (
		node !== null &&
		typeof node === 'object' &&
		!Array.isArray(node) &&
		Object.keys(node).some((key) => key.startsWith('.'))
	);
}

/** Resolves a conditional `exports` value to one target, `types` first then ESM order. */
function selectConditionTarget(node: unknown): string | undefined {
	if (typeof node === 'string') {
		return node;
	}
	if (Array.isArray(node)) {
		for (const item of node) {
			const target = selectConditionTarget(item);
			if (target !== undefined) {
				return target;
			}
		}
		return undefined;
	}
	if (node !== null && typeof node === 'object') {
		const record = node as Record<string, unknown>;
		if ('types' in record) {
			const target = selectConditionTarget(record['types']);
			if (target !== undefined) {
				return target;
			}
		}
		for (const [key, value] of Object.entries(record)) {
			if (!key.startsWith('.') && key !== 'types' && ACTIVE_CONDITIONS.includes(key)) {
				const target = selectConditionTarget(value);
				if (target !== undefined) {
					return target;
				}
			}
		}
	}
	return undefined;
}

/** Lists every declaration file in the extracted tarball, excluding bundled deps. */
function allDeclarationFiles(fs: FileSystem, root: string): string[] {
	const out: string[] = [];
	for (const rel of fs.readdirRecursive(root)) {
		if (rel.split(sep).includes('node_modules')) {
			continue;
		}
		if (DTS_RE.test(rel)) {
			out.push(resolve(root, rel));
		}
	}
	return out;
}

/** Maps a runtime or declaration target to its declaration-file form, or `undefined`. */
function toDeclarationPath(target: string): string | undefined {
	if (DTS_RE.test(target)) {
		return target;
	}
	if (target.endsWith('.mjs')) {
		return `${target.slice(0, -'.mjs'.length)}.d.mts`;
	}
	if (target.endsWith('.cjs')) {
		return `${target.slice(0, -'.cjs'.length)}.d.cts`;
	}
	if (target.endsWith('.js')) {
		return `${target.slice(0, -'.js'.length)}.d.ts`;
	}
	return undefined;
}

interface RawSpecifier {
	specifier: string;
	kind: SpecifierKind;
	dynamic: boolean;
}

/** Extracts all module specifiers and type references from a declaration file. */
function specifiersIn(fs: FileSystem, file: string): RawSpecifier[] {
	const text = fs.readFile(file);
	const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const out: RawSpecifier[] = [];
	const isModule = ts.isExternalModule(sf);

	for (const directive of sf.typeReferenceDirectives) {
		// `/// <reference types="x" />` — a type-only requirement (resolved as a directive).
		out.push({ specifier: directive.fileName, kind: 'type-reference', dynamic: false });
	}

	const visit = (node: ts.Node): void => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			out.push({ specifier: node.moduleSpecifier.text, kind: 'module', dynamic: false });
		} else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference) &&
			ts.isStringLiteral(node.moduleReference.expression)
		) {
			out.push({ specifier: node.moduleReference.expression.text, kind: 'module', dynamic: false });
		} else if (ts.isImportTypeNode(node)) {
			const arg = node.argument;
			if (ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal)) {
				out.push({ specifier: arg.literal.text, kind: 'module', dynamic: false });
			} else {
				out.push({ specifier: arg.getText(sf), kind: 'module', dynamic: true });
			}
		} else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
			// A `declare module "x"` augmentation in an external-module file requires `x`
			// (so its types exist to augment). Ambient script stubs and pattern names
			// (`*.svg`) provide a module instead and are not requirements.
			const name = node.name.text;
			if (isModule && !name.includes('*')) {
				out.push({ specifier: name, kind: 'module', dynamic: false });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return out;
}

function isRelative(specifier: string): boolean {
	return specifier.startsWith('.');
}

/** Resolves a relative specifier from a `.d.ts` to the declaration file it targets. */
function resolveRelativeDts(
	fs: FileSystem,
	fromFile: string,
	specifier: string,
	root: string,
): string | undefined {
	const base = resolve(dirname(fromFile), specifier);
	const candidates = DTS_RE.test(specifier)
		? [base]
		: [
				declarationSibling(specifier, base),
				`${base}.d.ts`,
				`${base}.d.mts`,
				`${base}.d.cts`,
				join(base, 'index.d.ts'),
				join(base, 'index.d.mts'),
				join(base, 'index.d.cts'),
			];
	// Stay inside the package root and require an actual file.
	return candidates.find((c) => c !== undefined && isWithin(root, c) && fs.isFile(c));
}

/** For a relative `./x.js`-style import, the adjacent declaration path. */
function declarationSibling(specifier: string, base: string): string | undefined {
	const dts = toDeclarationPath(specifier);
	if (dts === undefined || dts === specifier) {
		return undefined;
	}
	return resolve(dirname(base), dts.slice(dts.lastIndexOf('/') + 1));
}
