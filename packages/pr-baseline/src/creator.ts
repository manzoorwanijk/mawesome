import { ConfigError, type ResolvedConfig } from './config.ts';
import type { ApiClient } from './github/api.ts';
import { isGitHubError } from './github/errors.ts';

export const ACTIONS_BOT = 'github-actions[bot]';

/**
 * Resolves the login statuses will be written as, without a write and without guessing.
 * Order: explicit creator, the workflow's own token, then `GET /user` for a user token.
 */
export async function resolveCreator(config: ResolvedConfig, api: ApiClient): Promise<string> {
	if (config.creator !== undefined) {
		return config.creator;
	}
	if (config.tokenIsWorkflowToken) {
		return ACTIONS_BOT;
	}
	if (!api.hasToken) {
		throw new ConfigError('Writing statuses needs a token: pass --token or set GITHUB_TOKEN.');
	}
	try {
		const user = await api.request('GET /user');
		return user.data.login;
	} catch (error) {
		if (isGitHubError(error, 'permission') || isGitHubError(error, 'auth')) {
			throw new ConfigError(
				`Cannot resolve the status creator from this token; pass --creator with the login it writes as (for example "${ACTIONS_BOT}" or "<app-slug>[bot]").`,
				{ cause: error },
			);
		}
		throw error;
	}
}
