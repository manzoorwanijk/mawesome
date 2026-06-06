/**
 * Aggregate each tool's docs into the Starlight site.
 *
 * The single source of truth for a tool's documentation is `packages/<tool>/docs/*.md`.
 * This script copies those files into `src/content/docs/<tool>/`, adding the frontmatter
 * Starlight needs and rewriting cross-doc links to site routes.
 * The generated copies are gitignored; re-run via the `sync:docs` script (wired into dev/build/typecheck).
 *
 * Why string ops instead of a remark roundtrip: the docs use GFM tables, which a
 * `remark-parse` → `remark-stringify` pass would reformat or corrupt without the exact
 * matching extensions. We only need the leading H1 and relative `.md` links, both of which
 * a precise regex handles without touching the rest of the document.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Tool, tools } from '../src/tools.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const packagesDir = join(repoRoot, 'packages');
const outRoot = join(here, '../src/content/docs');

/**
 * Branch the `editUrl`s point at. On Cloudflare a production deploy sets `CF_PAGES_BRANCH` to the
 * production branch and a preview to its feature branch, so "Edit page" tracks the deployed source.
 */
const sourceBranch = process.env.CF_PAGES_BRANCH ?? process.env.DOCS_SOURCE_BRANCH ?? 'main';

/** Normalize a package `repository` field into a GitHub blob base for the package's source tree. */
function githubBlobBase(pkgJson: { repository?: { url?: string; directory?: string } }): string {
	const url = pkgJson.repository?.url ?? '';
	const directory = pkgJson.repository?.directory ?? '';
	const https = url.replace(/^git\+/, '').replace(/\.git$/, '');
	return `${https}/blob/${sourceBranch}/${directory}`;
}

/**
 * Split off the document's leading `# H1`: returns its text (ATX-close `#`s stripped) and the body
 * with that heading line removed (Starlight renders the frontmatter `title` as the page heading).
 * Anchored to the file start so a `#` inside a later code fence is never mistaken for the title;
 * throws if the file does not open with an H1, surfacing the bad doc instead of guessing.
 */
function splitLeadingH1(markdown: string, file: string): { title: string; body: string } {
	const match = /^\uFEFF?#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*\r?\n+/.exec(markdown);
	if (!match) {
		throw new Error(`[sync-docs] ${file}: expected a leading "# H1" heading on the first line.`);
	}
	return { title: match[1], body: markdown.slice(match[0].length) };
}

/**
 * Rewrite relative `.md` links, preserving any `#anchor`/`?query` suffix and link title:
 * - `./x.md[#a]`      → `/<tool>/x/[#a]`   (`./README.md` → `/<tool>/`)
 * - `../<path>.md[#a]` → the package source on GitHub (the root README isn't a site page)
 */
export function rewriteLinks(markdown: string, toolSlug: string, blobBase: string): string {
	return markdown.replace(
		/\]\((\.\.?\/[^)\s]+?\.md)((?:[?#][^)\s]*)?)(\s+(?:"[^"]*"|'[^']*'))?\)/g,
		(_match, path: string, suffix = '', title = '') => {
			let target: string;
			if (path.startsWith('./')) {
				const name = path.slice(2).replace(/\.md$/, '');
				target = name === 'README' ? `/${toolSlug}/` : `/${toolSlug}/${name}/`;
			} else {
				target = `${blobBase}/${path.replace(/^\.\.\//, '')}`;
			}
			return `](${target}${suffix}${title})`;
		},
	);
}

/** Build a Starlight frontmatter block. `title`/`editUrl` are quoted; `sidebar` is nested YAML. */
function frontmatter(title: string, editUrl: string, order: number, isIndex: boolean): string {
	const sidebar = isIndex ? `  order: ${order}\n  label: Overview` : `  order: ${order}`;
	return [
		'---',
		`title: ${JSON.stringify(title)}`,
		`editUrl: ${JSON.stringify(editUrl)}`,
		'sidebar:',
		sidebar,
		'---',
		'',
	].join('\n');
}

function syncTool(tool: Tool): number {
	const { slug, docOrder } = tool;
	const docsDir = join(packagesDir, slug, 'docs');
	if (!existsSync(docsDir)) {
		throw new Error(
			`[sync-docs] ${slug}: no docs directory at ${docsDir} (registered in src/tools.ts).`,
		);
	}
	const pkgJson = JSON.parse(readFileSync(join(packagesDir, slug, 'package.json'), 'utf8'));
	const blobBase = githubBlobBase(pkgJson);

	const outDir = join(outRoot, slug);
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });

	const files = readdirSync(docsDir).filter((f) => f.endsWith('.md'));
	for (const file of files) {
		const base = file.replace(/\.md$/, '');
		const isIndex = base === 'README';
		const source = readFileSync(join(docsDir, file), 'utf8');

		// README is the section index (order 0); listed docs follow in order; the rest sort after.
		const order = isIndex ? 0 : docOrder.indexOf(base) + 1 || docOrder.length + 1;
		const { title, body: stripped } = splitLeadingH1(source, file);
		const head = frontmatter(title, `${blobBase}/docs/${file}`, order, isIndex);
		const linked = rewriteLinks(stripped, slug, blobBase);
		// The section overview (README) leads with the current published version, linked to npm.
		const body = isIndex
			? `[\`${tool.npm}@${pkgJson.version}\`](https://www.npmjs.com/package/${tool.npm})\n\n${linked}`
			: linked;
		const outName = isIndex ? 'index.md' : file;
		writeFileSync(join(outDir, outName), `${head}\n${body}`);
	}
	return files.length;
}

export function syncAllDocs(): void {
	for (const tool of tools) {
		const count = syncTool(tool);
		console.log(`[sync-docs] ${tool.slug}: ${count} page(s)`);
	}
}

if (import.meta.main) {
	syncAllDocs();
}
