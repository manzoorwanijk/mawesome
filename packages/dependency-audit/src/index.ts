/**
 * @mawesome/dependency-audit — verify every reachable bare import in a package's
 * released artifact (type `.d.ts` + runtime JS surfaces) is declared and resolvable.
 *
 * This is the Node entry: `audit(target)` acquires a directory or `.tgz` and runs over
 * the real filesystem. The runtime-agnostic core (`auditPackage`, `createMemoryFileSystem`)
 * is re-exported here and also available from `@mawesome/dependency-audit/browser`.
 */
export { audit } from './audit.ts';
export { auditPackage, type AuditPackageOptions } from './audit-core.ts';
export { DEFAULT_EXTRACT_LIMITS, ExtractLimitError } from './extract.ts';
export { createMemoryFileSystem, type FileSystem, type WritableFileSystem } from './fs.ts';
export { nodeFileSystem } from './fs-node.ts';
export { createPacoteProvider, type PacoteProviderOptions, pacoteProvider } from './provider.ts';
export type {
	AcquiredSource,
	AuditOptions,
	AuditResult,
	ExtractLimits,
	Finding,
	FindingKind,
	IgnoreRule,
	Notice,
	NoticeKind,
	RegistryProvider,
	ResolvedDependency,
	Surface,
	UncheckedSpecifier,
} from './types.ts';
