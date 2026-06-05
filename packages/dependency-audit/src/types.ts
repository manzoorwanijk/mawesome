/** Public types for the dependency audit. v1 covers the type (`.d.ts`) surface only. */

/** The released surface a finding was discovered on. v1 audits only `types`. */
export type Surface = 'types';

/**
 * Why a reachable specifier failed the audit.
 * - `undeclared`: the owning package is not declared in any non-dev manifest field.
 * - `missing-types`: the package is declared but provides no resolvable declarations
 *   for the exact specifier (the headline bug — e.g. a `.d.ts` `import('react')`
 *   with no `@types/react` declared).
 */
export type FindingKind = 'undeclared' | 'missing-types';

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

/** A declared dependency materialized for resolution, with the version selected. */
export interface ResolvedDependency {
	name: string;
	range: string;
	/** The version the provider materialized, or `undefined` if it could not be fetched. */
	version: string | undefined;
}

/** The result of auditing a single target. */
export interface AuditResult {
	/** The target as passed in (directory or `.tgz` path). */
	target: string;
	packageName: string | undefined;
	packageVersion: string | undefined;
	/** `true` when there are no findings. */
	ok: boolean;
	findings: Finding[];
	unchecked: UncheckedSpecifier[];
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

/** Options for {@link audit}. */
export interface AuditOptions {
	/** Override the dependency artifact provider (tests inject a hermetic one). */
	provider?: RegistryProvider;
}
