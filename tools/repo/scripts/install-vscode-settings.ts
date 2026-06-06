/**
 * Installs the repo's recommended VS Code settings (opt-in).
 * Copies `.vscode/settings.dist.jsonc` to `.vscode/settings.json` (which is gitignored),
 * but only when the local file is absent or still carries the managed marker — so a
 * developer's own customizations are never clobbered.
 * Run: `node tools/repo/scripts/install-vscode-settings.ts` (or `pnpm vscode:setup`).
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MANAGED_MARKER = '@mawesome/managed-vscode-settings';

function repoPath(relative: string): string {
	return fileURLToPath(new URL(`../../../${relative}`, import.meta.url));
}

function main(): void {
	const dist = repoPath('.vscode/settings.dist.jsonc');
	const local = repoPath('.vscode/settings.json');

	if (existsSync(local) && !readFileSync(local, 'utf8').includes(MANAGED_MARKER)) {
		console.log('vscode:setup: .vscode/settings.json exists and is not managed — left untouched.');
		return;
	}

	copyFileSync(dist, local);
	console.log('vscode:setup: wrote .vscode/settings.json from settings.dist.jsonc.');
}

if (import.meta.main) {
	main();
}
