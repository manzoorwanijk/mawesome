import starlight from '@astrojs/starlight';
import { defineConfig, passthroughImageService } from 'astro/config';
import { tools } from './src/tools.ts';

// Served at the root of a *.pages.dev project subdomain → base '/'.
export default defineConfig({
	base: '/',
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
			// One sidebar group per registered tool; items auto-generate from the synced docs
			// (scripts/sync-docs.ts), ordered by each page's `sidebar` frontmatter.
			sidebar: tools.map((tool) => ({
				label: tool.name,
				items: [{ autogenerate: { directory: tool.slug } }],
			})),
		}),
	],
});
