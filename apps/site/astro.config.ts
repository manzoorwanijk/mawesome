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

// Served at the root of a *.pages.dev project subdomain → base '/'.
export default defineConfig({
	base: '/',
	/*
	 * Cloudflare sets CF_PAGES_URL to the deployment's canonical URL (production or preview), enabling
	 * the sitemap and absolute canonical/OG URLs.
	 * Unset locally → those are simply skipped.
	 */
	site: process.env.CF_PAGES_URL,
	vite: { plugins: [aliasNodePathInClient()] },
	// Avoid `sharp` (native libvips) — a docs site doesn't need image optimization, and it
	// keeps the build-script allowlist to just `esbuild`.
	image: { service: passthroughImageService() },
	integrations: [
		starlight({
			title: 'mawesome',
			tagline: 'Sharp, single-purpose tools for npm package authors.',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/manzoorwanijk/mawesome' },
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
