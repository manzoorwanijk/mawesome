import { execFileSync } from 'node:child_process';

/** Resolves a ref in the local repository; null when there is no repository or no such ref. */
export function tryRevParse(ref: string, cwd: string | undefined): string | null {
	try {
		const output = execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
			cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		const sha = output.trim();
		return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
	} catch {
		return null;
	}
}
