import { describe, expect, it } from 'vitest';
import {
	ConfigError,
	DEFAULT_DESCRIPTIONS,
	DEFAULT_LABEL,
	DEFAULT_TAG,
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
		expect(config.baselines).toEqual([{ tag: DEFAULT_TAG, label: DEFAULT_LABEL }]);
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
			descriptions: { fail: 'Nope: {tags}', pass: '' },
		});
		expect(config.descriptions).toEqual({ ...DEFAULT_DESCRIPTIONS, fail: 'Nope: {tags}' });
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
				{ tag: 'repo', label: ' Require PR update ', markers: ['.nvmrc'] },
				{ tag: 'pkg/a', scope: ['packages/a/'] },
			]),
		).toEqual([
			{ tag: 'repo', label: 'Require PR update', markers: ['.nvmrc'] },
			{ tag: 'pkg/a', scope: ['packages/a/'] },
		]);
	});

	it.each([
		['not an array', {}],
		['an empty list', []],
		['a non-object entry', ['x']],
		['an unknown field', [{ tag: 'a', paths: [] }]],
		['a missing tag', [{ label: 'x' }]],
		['an invalid tag', [{ tag: 'bad..name' }]],
		['a duplicate tag', [{ tag: 'a' }, { tag: 'a' }]],
		['an empty label', [{ tag: 'a', label: '  ' }]],
		['an empty scope', [{ tag: 'a', scope: [] }]],
		['an empty marker pattern', [{ tag: 'a', markers: [''] }]],
		['a non-string pattern', [{ tag: 'a', markers: [1] }]],
	])('rejects %s', (_name, value) => {
		expect(() => validateBaselines(value)).toThrow(ConfigError);
	});
});

describe('shorthandBaselines', () => {
	it('builds one unscoped entry with defaults', () => {
		expect(shorthandBaselines({})).toEqual([{ tag: DEFAULT_TAG, label: DEFAULT_LABEL }]);
		expect(shorthandBaselines({ tag: 'x', label: 'L', markers: ['a'] })).toEqual([
			{ tag: 'x', label: 'L', markers: ['a'] },
		]);
	});
});

describe('parseBaselines', () => {
	it('parses inline JSON and @file references', () => {
		const files: Record<string, string> = { '/tmp/b.json': '[{"tag":"file"}]' };
		expect(parseBaselines('[{"tag":"inline"}]', () => '')).toEqual([{ tag: 'inline' }]);
		expect(parseBaselines('@/tmp/b.json', (path) => files[path] ?? '')).toEqual([{ tag: 'file' }]);
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
