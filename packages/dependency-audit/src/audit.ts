import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquire } from './acquire.ts';
import { auditPackage } from './audit-core.ts';
import { nodeFileSystem } from './fs-node.ts';
import { pacoteProvider } from './provider.ts';
import type { AuditOptions, AuditResult } from './types.ts';

/**
 * Audits a single target (a package directory or a `.tgz`) on Node: acquires the
 * artifact, materializes declared deps into a temp dir, and runs the FS-agnostic
 * {@link auditPackage} core over the real filesystem.
 */
export async function audit(target: string, options: AuditOptions = {}): Promise<AuditResult> {
	const provider = options.provider ?? pacoteProvider;
	const acquired = await acquire(target);
	const workDir = mkdtempSync(join(tmpdir(), 'dep-audit-deps-'));
	try {
		return await auditPackage(nodeFileSystem, acquired.root, {
			provider,
			workDir,
			target,
			source: acquired.source,
		});
	} finally {
		rmSync(workDir, { recursive: true, force: true });
		acquired.cleanup();
	}
}
