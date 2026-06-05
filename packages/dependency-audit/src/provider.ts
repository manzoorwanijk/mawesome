import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import pacote from 'pacote';
import { DEFAULT_EXTRACT_LIMITS, extractTarball } from './extract.ts';
import type { ExtractLimits, RegistryProvider } from './types.ts';

/**
 * Builds a registry provider that materializes a declared dependency from npm at the
 * highest version satisfying its range, into `<intoDir>/node_modules/<name>`. Fetches
 * reuse npm's cache/auth via pacote; extraction is bomb-guarded by `limits`.
 */
export function createPacoteProvider(
	limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS,
): RegistryProvider {
	return {
		async materialize(name: string, range: string, intoDir: string): Promise<string | undefined> {
			const dest = join(intoDir, 'node_modules', name);
			try {
				const fetched = await pacote.tarball(`${name}@${range}`);
				await extractTarball(fetched, dest, limits);
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
}

/** The default registry provider (default extraction caps). */
export const pacoteProvider: RegistryProvider = createPacoteProvider();
