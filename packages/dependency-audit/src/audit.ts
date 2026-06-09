import { mkdtempSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquire } from './acquire.ts';
import { auditPackage } from './audit-core.ts';
import { nodeFileSystem } from './fs-node.ts';
import { emit } from './progress.ts';
import { createPacoteProvider } from './provider.ts';
import type { AuditOptions, AuditResult } from './types.ts';

/**
 * Audits a single target (a package directory or a `.tgz`) on Node: acquires the
 * artifact, materializes declared deps into a temp dir, and runs the FS-agnostic
 * {@link auditPackage} core over the real filesystem.
 */
export async function audit(target: string, options: AuditOptions = {}): Promise<AuditResult> {
	emit(options.progress, { type: 'acquire:start', target });
	try {
		const acquired = await acquire(target, options.extractLimits);
		// The default provider honors the extraction caps and resolves `file:` deps relative to
		// the acquired package (so a monorepo's `file:../sibling` deps materialize locally).
		const provider =
			options.provider ??
			createPacoteProvider({
				limits: options.extractLimits,
				where: acquired.root,
				retries: options.retries,
			});
		const workDir = mkdtempSync(join(tmpdir(), 'dep-audit-deps-'));
		try {
			return await auditPackage(nodeFileSystem, acquired.root, {
				provider,
				workDir,
				target,
				source: acquired.source,
				ignore: options.ignore ?? [],
				conditions: options.conditions ?? [],
				// Only set when present — the option type is exact-optional (no explicit `undefined`).
				...(options.materializeConcurrency !== undefined
					? { materializeConcurrency: options.materializeConcurrency }
					: {}),
				...(options.progress ? { progress: options.progress } : {}),
				// Use the running Node's live builtin list (the core defaults to a hardcoded one).
				builtins: builtinModules,
			});
		} finally {
			rmSync(workDir, { recursive: true, force: true });
			acquired.cleanup();
		}
	} finally {
		// Always close the target's lifecycle — on success, an acquisition failure, or a skip.
		emit(options.progress, { type: 'target:done', target });
	}
}
