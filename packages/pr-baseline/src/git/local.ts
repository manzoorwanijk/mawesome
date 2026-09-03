import { execFileSync } from 'node:child_process';
import { gitBaseEnv } from './repo.ts';

/** Resolves a ref in the local repository; null when there is no repository or no such ref. */
export function tryRevParse(ref: string, cwd: string | undefined, token?: string): string | null {
	try {
		const output = execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
			cwd,
			encoding: 'utf8',
			// Even outside the adapter, git never sees the token and never fetches on its own.
			env: gitBaseEnv(process.env, { offline: true, ...(token === undefined ? {} : { token }) }),
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		const sha = output.trim();
		return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
	} catch {
		return null;
	}
}
