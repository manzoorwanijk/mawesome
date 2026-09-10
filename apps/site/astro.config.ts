import { fileURLToPath } from 'node:url';
import starlight from '@astrojs/starlight';
import { defineConfig, passthroughImageService } from 'astro/config';
import { tools } from './src/tools.ts';

/**
 * Redirect `node:path` to a browser path impl (`pathe`) — but ONLY in the client bundle, where the
 * dependency-audit playground core needs it. A global alias would also hijack `node:path` for
 * build-time deps (e.g. vfile in the markdown pipeline), which must keep the real builtin.
 *
 * Resolve via `import.meta.resolve` so the `import` condition wins (pathe's ESM `dist/index.mjs`);
 * `require.resolve` would pick the CJS build, whose named exports (`dirname`, …) Vite can't bind.
 */
const patheEntry = fileURLToPath(import.meta.resolve('pathe'));
function aliasNodePathInClient() {
	return {
		name: 'alias-node-path-in-client',
		enforce: 'pre' as const,
		resolveId(source: string, _importer: string | undefined, options?: { ssr?: boolean }) {
			return source === 'node:path' && !options?.ssr ? patheEntry : null;
		},
	};
}

const DOCS_SITE_URL = 'https://mawesome.dev';

// Served at the root of its own domain → base '/'.
export default defineConfig({
	base: '/',
	/*
	 * Production is served from the custom domain, so canonical/OG/sitemap URLs must use it.
	 * CF_PAGES_URL is the per-deployment *.pages.dev URL: right for previews, wrong for production.
	 * Both unset locally, so those URLs are simply skipped.
	 */
	site: process.env.CF_PAGES_BRANCH === 'main' ? DOCS_SITE_URL : process.env.CF_PAGES_URL,
	vite: { plugins: [aliasNodePathInClient()] },
	// Avoid `sharp` (native libvips) — a docs site doesn't need image optimization, and it
	// keeps the build-script allowlist to just `esbuild`.
	image: { service: passthroughImageService() },
	integrations: [
		starlight({
			title: 'mawesome',
			customCss: ['./src/styles/custom.css'],
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/mawesomedev/mawesome' },
			],
			// One sidebar group per registered tool: docs auto-generate from the synced directory
			// (scripts/sync-docs.ts, ordered by each page's `sidebar` frontmatter), plus a Playground
			// link for tools that ship one.
			sidebar: tools.map((tool) => ({
				label: tool.name,
				items: [
					{ autogenerate: { directory: tool.slug } },
					...(tool.playground
						? [
								{
									label: 'Playground',
									link: `/${tool.slug}/playground/`,
									badge: { text: 'Live', variant: 'tip' as const },
								},
							]
						: []),
				],
			})),
		}),
	],
});
