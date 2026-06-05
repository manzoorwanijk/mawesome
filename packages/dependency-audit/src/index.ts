/**
 * @mawesome/dependency-audit — verify every reachable bare import in a package's
 * released artifact is declared and resolvable. v1 audits the type (`.d.ts`) surface.
 */
export { audit } from './audit.ts';
export { pacoteProvider } from './provider.ts';
export type {
	AuditOptions,
	AuditResult,
	Finding,
	FindingKind,
	RegistryProvider,
	ResolvedDependency,
	Surface,
	UncheckedSpecifier,
} from './types.ts';
