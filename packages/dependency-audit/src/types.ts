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
 * - `unresolved`: the package is declared but the runtime specifier does not resolve
 *   to a file (e.g. a deep import of a subpath the dep's `exports` does not expose).
 */
export type FindingKind = 'undeclared' | 'missing-types' | 'unresolved';

/** A single undeclared/unresolvable import on a released surface. */
export interface Finding {
	/** The bare specifier exactly as written, e.g. `react/jsx-runtime`. */
	specifier: string;
	/** The normalized owning package, e.g. `react`. */
	packageName: string;
	surface: Surface;
	kind: FindingKind;
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
	/** Optional progress sink, notified at each audit phase (acquire, materialize, scan). */
	progress?: ProgressReporter;
}
