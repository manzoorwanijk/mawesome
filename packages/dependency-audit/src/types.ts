/** Public types for the dependency audit (type `.d.ts` + runtime JS surfaces). */

import type { ProgressReporter } from './progress.ts';

/** The released surface a finding was discovered on. */
export type Surface = 'types' | 'runtime';

/**
 * Why a reachable specifier failed the audit.
 * - `undeclared`: the owning package is not declared in any non-dev manifest field.
 * - `missing-types`: the package is declared but provides no resolvable declarations
 *   for the exact specifier (the headline type bug — e.g. a `.d.ts` `import('react')`
 *   with no `@types/react` declared).
 * - `types-unavailable`: like `missing-types`, but a registry probe found that no
 *   `@types/*` companion exists — so the gap is *not* fixable by declaring a dependency
 *   (ship types upstream, or add a local ambient `declare module`). Distinct so a CI gate
 *   can treat a genuinely-unfixable gap differently from a forgotten declaration.
 * - `unresolved`: the package is declared but the runtime specifier does not resolve
 *   to a file (e.g. a deep import of a subpath the dep's `exports` does not expose).
 *
 * Treat this as an open set — new kinds may be added in a minor release, so consumers
 * switching on it should keep a default branch rather than assuming exhaustiveness.
 */
export type FindingKind = 'undeclared' | 'missing-types' | 'types-unavailable' | 'unresolved';

/**
 * The specific cause of a runtime `unresolved` finding, when static analysis can determine it:
 * - `subpath-not-exported`: the package's `exports` map does not expose this subpath.
 * - `file-missing`: the specifier maps to a target file that is not present.
 * - `condition-mismatch`: it resolves under the *other* call form — a `require` (CJS) of an `import`-only `exports`, or vice-versa (the ESM/CJS dual-package hazard).
 *
 * Absent when the cause is indeterminate (e.g. the package is not in the resolution tree).
 */
export type UnresolvedReason = 'subpath-not-exported' | 'file-missing' | 'condition-mismatch';

/**
 * Why a finding's real root cause is another audited target in the same run.
 * Set on a consumer's finding when the owning package is *itself* a target whose coverage
 * {@link Notice} (its types aren't built/reachable) explains the finding — so every consumer
 * points at the one producer to fix, rather than N look-alike findings. The producer is the
 * finding's own {@link Finding.packageName}.
 */
export interface FindingCause {
	/** The producer target (as passed to the audit) whose coverage notice is the root cause. */
	target: string;
	/** That producer's coverage notice kind. */
	notice: NoticeKind;
}

/** A single undeclared/unresolvable import on a released surface. */
export interface Finding {
	/** The bare specifier exactly as written, e.g. `react/jsx-runtime`. */
	specifier: string;
	/** The normalized owning package, e.g. `react`. */
	packageName: string;
	surface: Surface;
	kind: FindingKind;
	/** For an `unresolved` runtime finding, the classified cause (when determinable). */
	reason?: UnresolvedReason;
	/** Set in a multi-target run when another audited target (the producer) is the root cause. */
	causedBy?: FindingCause;
	/**
	 * Declared dependencies whose own public types *also* expose this package — a strong signal (not
	 * a proof) that the type leaked into the audited package's `.d.ts` through their API rather than a
	 * direct import (the `.d.ts` portability trap). If so, the durable fix is in the producer and
	 * declaring the type yourself is a workaround. Set on a `types`-surface `undeclared` finding;
	 * absent only when no declared dependency exposes the package.
	 */
	leakedVia?: string[];
	/** Package-relative path of the declaration file where it was first seen. */
	firstSeenIn: string;
	/** Human-readable remediation hint. */
	suggestion: string;
}

/** A specifier static analysis could not check (dynamic/opaque), surfaced not dropped. */
export interface UncheckedSpecifier {
	specifier: string;
	reason: string;
	firstSeenIn: string;
}

/**
 * Why a surface had nothing to analyze — so "audited, clean" is never confused with
 * "nothing to audit."
 * - `types-not-built`: the manifest declares type declarations, but none resolve from
 *   the package root (the build output is missing — build before auditing).
 * - `types-unreachable`: the package ships `.d.ts` files, but no `types` field or
 *   `exports` `types` condition exposes them (a likely packaging gap).
 */
export type NoticeKind = 'types-not-built' | 'types-unreachable';

/** A non-fatal coverage notice: a surface that could not be analyzed, and why. */
export interface Notice {
	kind: NoticeKind;
	surface: Surface;
	message: string;
}

/** A declared dependency materialized for resolution, with the version selected. */
export interface ResolvedDependency {
	name: string;
	range: string;
	/** The version the provider materialized, or `undefined` if it could not be fetched. */
	version: string | undefined;
}

/** How a target was acquired, and (for fetched specs) what it resolved to. */
export interface AcquiredSource {
	/** `directory` (local dir), `tarball` (local `.tgz`), or `spec` (registry/URL). */
	kind: 'directory' | 'tarball' | 'spec';
	/** For a fetched spec: the resolved identity and integrity (a tag moves over time). */
	resolved?: {
		name: string | undefined;
		version: string | undefined;
		/** The tarball URL pacote resolved to. */
		tarball: string;
		/** The Subresource Integrity (SRI) string of the fetched tarball. */
		integrity: string;
	};
}

/**
 * Suppresses intentional findings (e.g. an optional/plugin import static analysis can't
 * prove). A rule matches a finding when every field it specifies equals the finding's;
 * an empty rule matches nothing. Suppressed findings are echoed in {@link AuditResult.ignored}.
 *
 * `package`/`specifier`/`surface`/`kind` match the finding itself and apply across every
 * audited target. `target`/`path` *scope* a rule to where it fires, so a localized suppression
 * (a test fixture, a generated file) can't also hide a genuine regression of the same specifier
 * elsewhere in the run: `target` restricts it to one audited package, while `path` alone scopes
 * by location (a `firstSeenIn` glob) and still applies in every target — combine the two to
 * confine a rule to one package's files.
 */
export interface IgnoreRule {
	/** Match by owning package name (e.g. `react`). */
	package?: string;
	/** Match by exact specifier (e.g. `react/jsx-runtime`). */
	specifier?: string;
	/** Match by surface (`types` or `runtime`). */
	surface?: Surface;
	/** Match by finding kind. */
	kind?: FindingKind;
	/** Scope to one audited target — its package name *or* the target as passed (dir/`.tgz`/spec). */
	target?: string;
	/** Scope to files whose package-relative `firstSeenIn` matches this glob (`**`, `*`, `?`). */
	path?: string;
}

/** The result of auditing a single target. */
export interface AuditResult {
	/** The target as passed in (directory, `.tgz` path, or package spec). */
	target: string;
	/** How the target was acquired (and what a spec resolved to). */
	source: AcquiredSource;
	packageName: string | undefined;
	packageVersion: string | undefined;
	/** `true` when there are no non-ignored findings. */
	ok: boolean;
	findings: Finding[];
	/** Findings suppressed by an {@link IgnoreRule}, surfaced for auditability. */
	ignored: Finding[];
	unchecked: UncheckedSpecifier[];
	/** Non-fatal coverage notices (e.g. a package whose types were not built / unreachable). */
	notices: Notice[];
	resolvedDeps: ResolvedDependency[];
}

/**
 * Materializes a declared dependency's artifact so resolution runs against the
 * target's *declared ranges*, never the author's ambient `node_modules`.
 * Implementations extract `name`@(highest satisfying `range`) into
 * `<intoDir>/node_modules/<name>` and return the resolved version.
 */
export interface RegistryProvider {
	materialize(name: string, range: string, intoDir: string): Promise<string | undefined>;
	/**
	 * Optional capability: does `name` exist on the registry?
	 * Used only to refine a `missing-types` finding into honest advice — when the probed
	 * `@types/*` companion is `absent`, the gap is reclassified `types-unavailable`.
	 * Returns `unknown` when the lookup can't run (offline, no network, or a transient
	 * error), which preserves the conservative `missing-types` message. A provider that
	 * omits this method disables the refinement entirely (the browser default has no network).
	 */
	packageExists?(name: string): Promise<'exists' | 'absent' | 'unknown'>;
	/**
	 * Optional capability: the registry's current version of `name` if it ships its own types and
	 * differs from `currentVersion` (the resolved one, which ships none) — used to turn a dead-end
	 * `types-unavailable` into "depend on that version instead". Returns `undefined` when no such
	 * version is known (or the lookup can't run). A provider that omits this disables the upgrade hint.
	 */
	latestTypedVersion?(name: string, currentVersion: string): Promise<string | undefined>;
}

/** Caps on tarball extraction, to bound decompression bombs. */
export interface ExtractLimits {
	/** Maximum total uncompressed bytes before extraction aborts. */
	maxBytes: number;
	/** Maximum number of entries before extraction aborts. */
	maxEntries: number;
}

/** Options for {@link audit}. */
export interface AuditOptions {
	/** Override the dependency artifact provider (tests inject a hermetic one). */
	provider?: RegistryProvider;
	/** Rules that suppress intentional findings. */
	ignore?: IgnoreRule[];
	/** Override the tarball extraction caps for the acquired target (defaults apply otherwise). */
	extractLimits?: ExtractLimits;
	/** Extra resolution conditions to activate (e.g. `["browser"]`), added to the defaults. */
	conditions?: readonly string[];
	/** Cap on concurrent dependency materializations for this target (default 12). */
	materializeConcurrency?: number;
	/** Extra attempts for a transient registry fetch/extract failure (default 3); ignored when `provider` is set. */
	retries?: number;
	/** Optional progress sink, notified at each audit phase (acquire, materialize, scan). */
	progress?: ProgressReporter;
}
