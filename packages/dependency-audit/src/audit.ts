import { mkdtempSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquire } from './acquire.ts';
import { auditPackage } from './audit-core.ts';
import { nodeFileSystem } from './fs-node.ts';
import { createPacoteProvider } from './provider.ts';
import type { AuditOptions, AuditResult } from './types.ts';

/**
 * Audits a single target (a package directory or a `.tgz`) on Node: acquires the
 * artifact, materializes declared deps into a temp dir, and runs the FS-agnostic
 * {@link auditPackage} core over the real filesystem.
 */
export async function audit(target: string, options: AuditOptions = {}): Promise<AuditResult> {
	const acquired = await acquire(target, options.extractLimits);
	// The default provider honors the extraction caps and resolves `file:` deps relative to
	// the acquired package (so a monorepo's `file:../sibling` deps materialize locally).
	const provider =
		options.provider ??
		createPacoteProvider({ limits: options.extractLimits, where: acquired.root });
	const workDir = mkdtempSync(join(tmpdir(), 'dep-audit-deps-'));
	try {
		return await auditPackage(nodeFileSystem, acquired.root, {
			provider,
			workDir,
			target,
			source: acquired.source,
			ignore: options.ignore ?? [],
			conditions: options.conditions ?? [],
			// Use the running Node's live builtin list (the core defaults to a hardcoded one).
			builtins: builtinModules,
		});
	} finally {
		rmSync(workDir, { recursive: true, force: true });
		acquired.cleanup();
	}
}
