import starlight from '@astrojs/starlight';
import { defineConfig, passthroughImageService } from 'astro/config';

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
			// Per-tool sections, auto-generated from the docs synced by scripts/sync-docs.ts.
			// Order and labels come from each page's `sidebar` frontmatter.
			sidebar: [
				{ label: 'dependency-audit', items: [{ autogenerate: { directory: 'dependency-audit' } }] },
			],
		}),
	],
});
