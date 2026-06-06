/**
 * Resolve a tool's published version from its `package.json` at build time.
 * Server-only (reads the filesystem) — import from `.astro`/`.mdx` frontmatter or build scripts,
 * never from client-side code.
 *
 * Resolves through the package's own export map (`./package.json`) rather than a path relative to
 * this file, so it survives Astro bundling this module into `dist/` (where `import.meta.url` would
 * otherwise point at the wrong tree).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The `version` field from the tool package's `package.json`, given its npm name. */
export function toolVersion(npm: string): string {
	const path = fileURLToPath(import.meta.resolve(`${npm}/package.json`));
	const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version: string };
	return pkg.version;
}
