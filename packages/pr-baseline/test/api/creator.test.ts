import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config.ts';
import { resolveCreator } from '../../src/creator.ts';
import { createApiClient } from '../../src/github/api.ts';
import { FakeGitHub } from '../helpers/fake-github.ts';

function setup(options: Parameters<typeof resolveConfig>[0], github = new FakeGitHub()) {
	const config = resolveConfig({ repo: github.repo, token: 'token', env: {}, ...options });
	const api = createApiClient({
		apiUrl: 'https://api.github.com',
		graphqlUrl: 'https://api.github.com/graphql',
		token: config.token,
		fetch: github.fetch,
		retryBaseMs: 0,
		logger: { info() {}, warn() {} },
	});
	return { config, api, github };
}

describe('resolveCreator', () => {
	it('uses an explicit creator without any request', async () => {
		const { config, api, github } = setup({ creator: 'my-app[bot]' });
		await expect(resolveCreator(config, api)).resolves.toBe('my-app[bot]');
		expect(github.calls).toHaveLength(0);
	});

	it('names the Actions bot when the token is provably the workflow token', async () => {
		const { config, api, github } = setup({ tokenIsWorkflowToken: true });
		await expect(resolveCreator(config, api)).resolves.toBe('github-actions[bot]');
		expect(github.calls).toHaveLength(0);
	});

	it('asks GET /user for a user token', async () => {
		const { config, api } = setup({});
		await expect(resolveCreator(config, api)).resolves.toBe('octocat');
	});

	it('fails with guidance for an App token without a creator', async () => {
		const github = new FakeGitHub({ user: null });
		const { config, api } = setup({}, github);
		await expect(resolveCreator(config, api)).rejects.toThrow(/pass --creator/);
	});

	it('fails without a token', async () => {
		const { config, api } = setup({ token: '' });
		await expect(resolveCreator(config, api)).rejects.toThrow(/needs a token/);
	});
});
