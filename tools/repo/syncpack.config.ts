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
			label: 'All external dependencies are sourced from the pnpm catalog.',
			dependencies: ['**'],
			packages: ['**'],
			policy: 'catalog',
		},
	],
	semverGroups: [
		{
			label: 'Catalog entries use caret ranges so security patches flow in.',
			dependencyTypes: ['pnpmCatalog'],
			packages: ['**'],
			range: '^',
		},
	],
} satisfies RcFile;
