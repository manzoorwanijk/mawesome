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
			// Per-tool sections; each tool gets an overview + its docs (+ an optional playground).
			sidebar: [
				{
					label: 'dependency-audit',
					items: [{ label: 'Overview', slug: 'dependency-audit' }],
				},
			],
		}),
	],
});
