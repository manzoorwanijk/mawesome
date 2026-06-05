import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import type { FileSystem } from './fs.ts';
import { expandPatternTarget, isWithin } from './fsutil.ts';
import type { Manifest } from './manifest.ts';
import type { UncheckedSpecifier } from './types.ts';

/** How a specifier was imported — selects the resolution condition set. */
export type CallForm = 'import' | 'require';

/** An external runtime specifier with its call form and first-seen file. */
export interface RuntimeSpecifier {
	specifier: string;
	form: CallForm;
	firstSeenIn: string;
}

/** The discovered runtime surface: scanned files and the specifiers they reference. */
export interface RuntimeScan {
	files: string[];
	externals: RuntimeSpecifier[];
	unchecked: UncheckedSpecifier[];
}

const JS_RE = /\.[mc]?js$/;

/* Both runtime profiles are audited: a dual package can expose different
 * specifiers under `import` vs `require`. `types` is never a runtime condition. */
const IMPORT_CONDITIONS = ['import', 'node', 'default'];
const REQUIRE_CONDITIONS = ['require', 'node', 'default'];

/**
 * Scans the package's released runtime surface: discovers JS entry points from the
 * manifest (both runtime profiles, plus `bin`), then follows relative imports across
 * JS files, collecting every external specifier with its call form.
 */
export function scanRuntimeSurface(
	fs: FileSystem,
	root: string,
	manifest: Manifest,
	conditions: readonly string[] = [],
): RuntimeScan {
	const externals: RuntimeSpecifier[] = [];
	const unchecked: UncheckedSpecifier[] = [];
	const seen = new Set<string>();
	const visited = new Set<string>();
	const queue = [...runtimeEntryPoints(fs, root, manifest, conditions)];
	const rootIsModule = manifest.type === 'module';

	while (queue.length > 0) {
		const file = queue.shift();
		if (file === undefined || visited.has(file)) {
			continue;
		}
		visited.add(file);
		const rel = relative(root, file);

		for (const ref of specifiersInJs(fs, file, isEsmFile(file, rootIsModule))) {
			if (isRelative(ref.specifier)) {
				const target = resolveRelativeJs(fs, file, ref.specifier, root);
				if (target !== undefined && !visited.has(target)) {
					queue.push(target);
				}
				continue;
			}
			if (ref.dynamic) {
				unchecked.push({ specifier: ref.specifier, reason: 'dynamic specifier', firstSeenIn: rel });
				continue;
			}
			const key = `${ref.form}:${ref.specifier}`;
			if (!seen.has(key)) {
				seen.add(key);
				externals.push({ specifier: ref.specifier, form: ref.form, firstSeenIn: rel });
			}
		}
	}

	return { files: [...visited].map((f) => relative(root, f)), externals, unchecked };
}

/** Discovers absolute paths of the runtime entry points from the manifest. */
function runtimeEntryPoints(
	fs: FileSystem,
	root: string,
	manifest: Manifest,
	conditions: readonly string[],
): string[] {
	const found = new Set<string>();
	const add = (target: string | undefined): void => {
		if (target !== undefined && JS_RE.test(target)) {
			const abs = resolve(root, target);
			if (fs.isFile(abs)) {
				found.add(abs);
			}
		}
	};

	if (manifest.exports !== undefined) {
		const expand = (target: string): void => expandPatternTarget(fs, root, target).forEach(add);
		exportsRuntimeTargets(manifest.exports, [...IMPORT_CONDITIONS, ...conditions]).forEach(expand);
		exportsRuntimeTargets(manifest.exports, [...REQUIRE_CONDITIONS, ...conditions]).forEach(expand);
	} else {
		// No `exports`: any published JS is deep-importable.
		add(manifest.main);
		add(manifest.module);
		for (const file of allJsFiles(fs, root)) {
			found.add(file);
		}
	}
	// `bin` files are executed regardless of `exports` encapsulation. A bin is often
	// extensionless with a `#!/usr/bin/env node` shebang, so accept those too.
	for (const target of binTargets(manifest)) {
		const abs = resolve(root, target);
		if (fs.isFile(abs) && (JS_RE.test(target) || hasNodeShebang(fs, abs))) {
			found.add(abs);
		}
	}
	return [...found];
}

/** `true` if the file begins with a `#!...node` shebang (an executable JS bin). */
function hasNodeShebang(fs: FileSystem, file: string): boolean {
	const firstLine = fs.readFile(file).split('\n', 1)[0] ?? '';
	return firstLine.startsWith('#!') && /\bnode\b/.test(firstLine);
}

/** Selects the runtime target(s) from an `exports` field for the given conditions. */
function exportsRuntimeTargets(exportsField: unknown, conditions: string[]): string[] {
	if (isSubpathMap(exportsField)) {
		const targets: string[] = [];
		for (const value of Object.values(exportsField)) {
			// Pattern subpath keys (`./*`) are included; their target is expanded later.
			const target = selectConditionTarget(value, conditions);
			if (target !== undefined) {
				targets.push(target);
			}
		}
		return targets;
	}
	const target = selectConditionTarget(exportsField, conditions);
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

/** Resolves a conditional `exports` value to one target in author-declared order. */
function selectConditionTarget(node: unknown, conditions: string[]): string | undefined {
	if (typeof node === 'string') {
		return node;
	}
	if (Array.isArray(node)) {
		for (const item of node) {
			const target = selectConditionTarget(item, conditions);
			if (target !== undefined) {
				return target;
			}
		}
		return undefined;
	}
	if (node !== null && typeof node === 'object') {
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			if (!key.startsWith('.') && conditions.includes(key)) {
				const target = selectConditionTarget(value, conditions);
				if (target !== undefined) {
					return target;
				}
			}
		}
	}
	return undefined;
}

/** Collects `bin` target paths (string or map form). */
function binTargets(manifest: Manifest): string[] {
	const bin = manifest.bin;
	if (typeof bin === 'string') {
		return [bin];
	}
	if (bin !== null && typeof bin === 'object') {
		return Object.values(bin);
	}
	return [];
}

/** Lists every JS file in the extracted tarball, excluding bundled deps. */
function allJsFiles(fs: FileSystem, root: string): string[] {
	const out: string[] = [];
	for (const rel of fs.readdirRecursive(root)) {
		if (rel.split(sep).includes('node_modules')) {
			continue;
		}
		if (JS_RE.test(rel)) {
			out.push(resolve(root, rel));
		}
	}
	return out;
}

interface RawSpecifier {
	specifier: string;
	form: CallForm;
	dynamic: boolean;
}

/** Whether a JS file is ESM, by extension then the package's `type` for `.js`. */
function isEsmFile(file: string, rootIsModule: boolean): boolean {
	const ext = extname(file);
	if (ext === '.mjs') {
		return true;
	}
	if (ext === '.cjs') {
		return false;
	}
	return rootIsModule;
}

/**
 * Extracts module specifiers from a JS file via the TS AST, tagged by call form.
 * `require(...)` is only collected in CJS context and static `import`/`export … from`
 * only in ESM context, so a local identifier named `require` in an ESM file (or stray
 * syntax) does not manufacture a false specifier.
 */
function specifiersInJs(fs: FileSystem, file: string, isEsm: boolean): RawSpecifier[] {
	const text = fs.readFile(file);
	const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const out: RawSpecifier[] = [];

	const visit = (node: ts.Node): void => {
		if (
			isEsm &&
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			out.push({ specifier: node.moduleSpecifier.text, form: 'import', dynamic: false });
		} else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference) &&
			ts.isStringLiteral(node.moduleReference.expression)
		) {
			out.push({
				specifier: node.moduleReference.expression.text,
				form: 'require',
				dynamic: false,
			});
		} else if (ts.isCallExpression(node)) {
			collectCall(node, isEsm, out);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return out;
}

/**
 * Classifies call-form specifiers: dynamic `import(...)` (any context); `require(...)` and
 * `require.resolve(...)` (CJS only); and `createRequire(...)(...)` (any context — the explicit
 * way to `require` from ESM). The `const r = createRequire(…); r(x)` variable form needs scope
 * tracking and is not handled (a documented limitation). Import attributes/assertions don't
 * change the specifier, so `import x from 'y' with { … }` is captured by the import paths above.
 */
function collectCall(node: ts.CallExpression, isEsm: boolean, out: RawSpecifier[]): void {
	const arg = node.arguments[0];
	if (arg === undefined) {
		return;
	}
	const callee = node.expression;
	if (callee.kind === ts.SyntaxKind.ImportKeyword) {
		pushCall(arg, 'import', out);
	} else if (isCreateRequireCall(callee)) {
		// `createRequire(...)(specifier)` works in both ESM and CJS.
		pushCall(arg, 'require', out);
	} else if (!isEsm && (isRequireIdentifier(callee) || isRequireResolve(callee))) {
		pushCall(arg, 'require', out);
	}
}

/** `require` (bare identifier call). */
function isRequireIdentifier(callee: ts.Expression): boolean {
	return ts.isIdentifier(callee) && callee.text === 'require';
}

/** `require.resolve` (property access). */
function isRequireResolve(callee: ts.Expression): boolean {
	return (
		ts.isPropertyAccessExpression(callee) &&
		ts.isIdentifier(callee.expression) &&
		callee.expression.text === 'require' &&
		callee.name.text === 'resolve'
	);
}

/** `createRequire(...)` — the callee of a `createRequire(...)(specifier)` call. */
function isCreateRequireCall(callee: ts.Expression): boolean {
	return (
		ts.isCallExpression(callee) &&
		ts.isIdentifier(callee.expression) &&
		callee.expression.text === 'createRequire'
	);
}

/** Records a call specifier, accepting string and no-substitution template literals. */
function pushCall(arg: ts.Expression, form: CallForm, out: RawSpecifier[]): void {
	if (ts.isStringLiteralLike(arg)) {
		out.push({ specifier: arg.text, form, dynamic: false });
	} else {
		out.push({ specifier: arg.getText(), form, dynamic: true });
	}
}

function isRelative(specifier: string): boolean {
	return specifier.startsWith('.');
}

/** Resolves a relative specifier from a JS file to the file it targets (node-like). */
function resolveRelativeJs(
	fs: FileSystem,
	fromFile: string,
	specifier: string,
	root: string,
): string | undefined {
	const base = resolve(dirname(fromFile), specifier);
	const candidates = [
		base,
		`${base}.js`,
		`${base}.cjs`,
		`${base}.mjs`,
		`${base}.json`,
		join(base, 'index.js'),
		join(base, 'index.cjs'),
		join(base, 'index.mjs'),
	];
	// Stay inside the package root and require an actual JS file.
	return candidates.find((c) => JS_RE.test(c) && isWithin(root, c) && fs.isFile(c));
}
