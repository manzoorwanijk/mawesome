/**
 * The tool registry — the single source of truth for which @mawesome/* tools the site presents.
 * Drives doc aggregation (scripts/sync-docs.ts), the Starlight sidebar (astro.config.ts), and the
 * homepage cards. Add a tool here (with a `packages/<slug>/docs/` directory) to surface it everywhere.
 */
export interface Tool {
	/** Route base and the `packages/<slug>` / `src/content/docs/<slug>` directory name. */
	slug: string;
	/** Display name (homepage card, sidebar group). */
	name: string;
	/** npm package name, e.g. for install snippets. */
	npm: string;
	/** One-line blurb for the homepage card. */
	tagline: string;
	/** Starlight icon name for the card (see https://starlight.astro.build/reference/icons/). */
	icon: string;
	/** Whether the tool ships an interactive in-browser playground (Phase 3 wires the route). */
	playground: boolean;
	/**
	 * Sidebar order of the tool's doc files, as basenames without `.md` and excluding `README`
	 * (always the section index). Files not listed sort after these, alphabetically.
	 */
	docOrder: string[];
}

export const tools: Tool[] = [
	{
		slug: 'dependency-audit',
		name: 'dependency-audit',
		npm: '@mawesome/dependency-audit',
		tagline:
			"Verify every reachable import in a package's released artifact is declared and resolvable through its dependencies.",
		icon: 'magnifier',
		playground: true,
		docOrder: [
			'get-started',
			'concepts',
			'why',
			'cli',
			'output-format',
			'findings',
			'api',
			'resolution',
			'limitations',
			'security',
			'comparison',
		],
	},
];
