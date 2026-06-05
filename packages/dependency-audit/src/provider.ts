import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import pacote from 'pacote';
import type { RegistryProvider } from './types.ts';

/**
 * The default provider: materializes a declared dependency from the npm registry
 * at the highest version satisfying its range, into `<intoDir>/node_modules/<name>`.
 * Fetches reuse npm's cache/auth via pacote.
 */
export const pacoteProvider: RegistryProvider = {
	async materialize(name: string, range: string, intoDir: string): Promise<string | undefined> {
		const dest = join(intoDir, 'node_modules', name);
		try {
			await pacote.extract(`${name}@${range}`, dest);
			const pkg = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')) as {
				version?: string;
			};
			return pkg.version;
		} catch {
			// Don't leave a partial extraction that could resolve to a broken tree.
			rmSync(dest, { recursive: true, force: true });
			return undefined;
		}
	},
};
