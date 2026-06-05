import type { RcFile } from 'syncpack';

export default {
	source: ['package.json', 'packages/*/package.json', 'tools/*/package.json'],
	versionGroups: [
		{
			label: 'Local workspace package versions are managed by changesets, not syncpack.',
			dependencyTypes: ['local'],
			isIgnored: true,
		},
		{
			label: 'Internal @mawesome/* packages use the workspace: protocol.',
			dependencies: ['@mawesome/**'],
			packages: ['**'],
			pinVersion: 'workspace:*',
		},
		{
			label: 'peerDependencies use intentionally wide ranges; enforce mutual satisfiability only.',
			dependencyTypes: ['peer'],
			policy: 'sameRange',
		},
		{
			label: 'Every other dependency uses one identical version across the whole repo.',
			dependencies: ['**'],
			packages: ['**'],
		},
	],
	semverGroups: [
		{
			label: 'The TypeScript native preview (tsgo) is pinned to an exact build (fast-moving).',
			dependencies: ['@typescript/native-preview'],
			packages: ['**'],
			range: '',
		},
		{
			label: 'All other dependencies use caret ranges so security patches flow in.',
			dependencies: ['**'],
			packages: ['**'],
			dependencyTypes: ['prod', 'dev'],
			range: '^',
		},
	],
} satisfies RcFile;
