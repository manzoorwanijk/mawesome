import { describe, expect, it } from 'vitest';
import {
	ConfigError,
	DEFAULT_DESCRIPTIONS,
	DEFAULT_LABEL,
	DEFAULT_NAME,
	graphqlUrlFor,
	parseBaselines,
	resolveConfig,
	serverUrlFor,
	shorthandBaselines,
	validateBaselines,
} from '../../src/config.ts';

describe('resolveConfig', () => {
	it('prefers flags over env and falls back to defaults', () => {
		const config = resolveConfig({
			repo: 'a/b',
			env: {
				GITHUB_REPOSITORY: 'x/y',
				GITHUB_TOKEN: 'env-token',
				GITHUB_API_URL: 'https://ghe.test/api/v3/',
			},
		});
		expect(config.repo).toBe('a/b');
		expect(config.token).toBe('env-token');
		expect(config.apiUrl).toBe('https://ghe.test/api/v3');
		expect(config.base).toBeUndefined();
		expect(config.baselines).toEqual([{ name: DEFAULT_NAME, label: DEFAULT_LABEL }]);
		expect(config.context).toBe('PR baseline');
		expect(config.descriptions).toEqual(DEFAULT_DESCRIPTIONS);
		expect(config.otherBases).toBe('skip');
		expect(config.ancestry).toBe('auto');
		expect(config.maxWritesPerRun).toBe(450);
		expect(config.maxWritesPerMinute).toBe(60);
		expect(config.includeDrafts).toBe(true);
	});

	it('merges partial description overrides', () => {
		const config = resolveConfig({
			repo: 'a/b',
			env: {},
			descriptions: { fail: 'Nope: {baselines}', pass: '' },
		});
		expect(config.descriptions).toEqual({ ...DEFAULT_DESCRIPTIONS, fail: 'Nope: {baselines}' });
	});

	it('rejects a missing or malformed repository before anything else', () => {
		expect(() => resolveConfig({ env: {} })).toThrow(ConfigError);
		expect(() => resolveConfig({ repo: 'nope', env: {} })).toThrow(/owner\/name/);
	});

	it('rejects bad enum values and non-positive limits', () => {
		expect(() => resolveConfig({ repo: 'a/b', env: {}, ancestry: 'magic' as never })).toThrow(
			ConfigError,
		);
		expect(() => resolveConfig({ repo: 'a/b', env: {}, otherBases: 'fail' as never })).toThrow(
			ConfigError,
		);
		expect(() => resolveConfig({ repo: 'a/b', env: {}, maxWritesPerRun: 0 })).toThrow(ConfigError);
		expect(() => resolveConfig({ repo: 'a/b', env: {}, maxWritesPerRun: 2 ** 53 })).toThrow(
			ConfigError,
		);
		expect(() => resolveConfig({ repo: 'a/b', env: {}, maxWritesPerMinute: 1e23 })).toThrow(
			ConfigError,
		);
		expect(() => resolveConfig({ repo: 'a/b', env: {}, maxWritesPerMinute: 1.5 })).toThrow(
			ConfigError,
		);
	});
});

describe('validateBaselines', () => {
	it('accepts the full schema', () => {
		expect(
			validateBaselines([
				{ name: 'repo', label: ' Require PR update ', markers: ['.nvmrc'] },
				{ name: 'pkg/a', scope: ['packages/a/'] },
			]),
		).toEqual([
			{ name: 'repo', label: 'Require PR update', markers: ['.nvmrc'] },
			{ name: 'pkg/a', scope: ['packages/a/'] },
		]);
	});

	it.each([
		['not an array', {}],
		['an empty list', []],
		['a non-object entry', ['x']],
		['an unknown field', [{ name: 'a', paths: [] }]],
		['a missing name', [{ label: 'x' }]],
		['an invalid name', [{ name: 'bad..name' }]],
		['a duplicate name', [{ name: 'a' }, { name: 'a' }]],
		['an empty label', [{ name: 'a', label: '  ' }]],
		['an empty scope', [{ name: 'a', scope: [] }]],
		['an empty marker pattern', [{ name: 'a', markers: [''] }]],
		['a non-string pattern', [{ name: 'a', markers: [1] }]],
	])('rejects %s', (_name, value) => {
		expect(() => validateBaselines(value)).toThrow(ConfigError);
	});
});

describe('shorthandBaselines', () => {
	it('builds one unscoped entry with defaults', () => {
		expect(shorthandBaselines({})).toEqual([{ name: DEFAULT_NAME, label: DEFAULT_LABEL }]);
		expect(shorthandBaselines({ name: 'x', label: 'L', markers: ['a'] })).toEqual([
			{ name: 'x', label: 'L', markers: ['a'] },
		]);
	});
});

describe('parseBaselines', () => {
	it('parses inline JSON and @file references', () => {
		const files: Record<string, string> = { '/tmp/b.json': '[{"name":"file"}]' };
		expect(parseBaselines('[{"name":"inline"}]', () => '')).toEqual([{ name: 'inline' }]);
		expect(parseBaselines('@/tmp/b.json', (path) => files[path] ?? '')).toEqual([{ name: 'file' }]);
	});

	it('reports invalid JSON as a configuration error', () => {
		expect(() => parseBaselines('{oops', () => '')).toThrow(/not valid JSON/);
	});
});

describe('graphqlUrlFor', () => {
	it('derives the GraphQL endpoint beside the REST root', () => {
		expect(graphqlUrlFor('https://api.github.com')).toBe('https://api.github.com/graphql');
		expect(graphqlUrlFor('https://ghe.test/api/v3')).toBe('https://ghe.test/api/graphql');
		expect(graphqlUrlFor('https://proxy.test/github')).toBe('https://proxy.test/github/graphql');
	});

	it('prefers an explicit GraphQL URL, then the env', () => {
		expect(
			resolveConfig({ repo: 'a/b', env: { GITHUB_GRAPHQL_URL: 'https://x/gql' } }).graphqlUrl,
		).toBe('https://x/gql');
		expect(resolveConfig({ repo: 'a/b', env: {}, graphqlUrl: 'https://y/gql' }).graphqlUrl).toBe(
			'https://y/gql',
		);
	});
});

describe('graphqlUrl normalization', () => {
	it('drops trailing slashes', () => {
		expect(
			resolveConfig({ repo: 'a/b', env: {}, graphqlUrl: 'https://ghe.test/api/graphql/' })
				.graphqlUrl,
		).toBe('https://ghe.test/api/graphql');
	});
});

describe('serverUrlFor', () => {
	it('derives the git server from the REST root', () => {
		expect(serverUrlFor('https://api.github.com')).toBe('https://github.com');
		expect(serverUrlFor('https://ghe.test/api/v3')).toBe('https://ghe.test');
		expect(
			resolveConfig({ repo: 'a/b', env: { GITHUB_SERVER_URL: 'https://ghe.test/' } }).serverUrl,
		).toBe('https://ghe.test');
	});
});
