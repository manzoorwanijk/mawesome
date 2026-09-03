import { ConfigError, type ResolvedConfig } from './config.ts';
import type { ApiClient } from './github/api.ts';
import { createApiAncestry } from './github/compare.ts';
import type { Ancestry, Logger } from './types.ts';

/** Picks the ancestry adapter for a run; `auto` prefers git when a usable clone exists. */
export function selectAncestry(config: ResolvedConfig, api: ApiClient, logger: Logger): Ancestry {
	if (config.ancestry === 'git') {
		throw new ConfigError('The git ancestry adapter is not available yet; use --ancestry api.');
	}
	if (!api.hasToken) {
		throw new ConfigError('API ancestry needs a token: pass --token or set GITHUB_TOKEN.');
	}
	return createApiAncestry(api, config.repo, logger);
}
