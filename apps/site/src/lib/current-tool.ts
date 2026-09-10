/**
 * Resolve which registered tool a page belongs to.
 * Docs and playground pages alike live under `/<slug>/`, so the first path segment identifies the tool.
 * Pages outside a tool (the homepage, 404) resolve to `undefined`.
 */
import { type Tool, tools } from '../tools.ts';

export function toolFromPath(pathname: string): Tool | undefined {
	const slug = pathname.replace(/^\/+/, '').split('/')[0];
	return tools.find((tool) => tool.slug === slug);
}
