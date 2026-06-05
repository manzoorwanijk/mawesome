/**
 * @mawesome/dependency-audit/browser — the filesystem-agnostic core.
 *
 * Runs in any JS runtime: no `node:fs`, `node:os`, `node:module`, or `pacote`. Supply an
 * already-populated {@link FileSystem} (e.g. {@link createMemoryFileSystem}) containing
 * the package to audit, and a {@link RegistryProvider} that materializes declared deps
 * into `workDir/node_modules` on that same filesystem. The only `node:` import is
 * `node:path`, which browser bundlers alias to `path-browserify`.
 */
export { auditPackage, type AuditPackageOptions } from './audit-core.ts';
export { createMemoryFileSystem, type FileSystem, type WritableFileSystem } from './fs.ts';
export type {
	AcquiredSource,
	AuditResult,
	Finding,
	FindingKind,
	RegistryProvider,
	ResolvedDependency,
	Surface,
	UncheckedSpecifier,
} from './types.ts';
