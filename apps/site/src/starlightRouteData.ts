/**
 * Scope the sidebar to the tool being read.
 * Listing every tool's pages at once obscured which package the current page belonged to.
 * The Sidebar override names the tool and links back to the tool list.
 */
import { defineRouteMiddleware, type StarlightRouteData } from '@astrojs/starlight/route-data';
import { toolFromPath } from './lib/current-tool.ts';

type SidebarEntry = StarlightRouteData['sidebar'][number];
type SidebarLink = StarlightRouteData['pagination']['prev'];

/** Whether a sidebar entry (or any entry nested in it) points inside the given tool's routes. */
function belongsToTool(entry: SidebarEntry, slug: string): boolean {
	return entry.type === 'group'
		? entry.entries.some((child) => belongsToTool(child, slug))
		: entry.href.startsWith(`/${slug}/`);
}

export const onRequest = defineRouteMiddleware(({ locals, url }) => {
	const route = locals.starlightRoute;
	const tool = toolFromPath(url.pathname);
	if (!tool) return;

	const group = route.sidebar.find((entry) => belongsToTool(entry, tool.slug));
	// Drop the group wrapper: with a single tool listed, its collapsible header only adds a click.
	if (group?.type === 'group') route.sidebar = group.entries;

	// Pagination is derived from the unfiltered sidebar, so a tool's first and last page would otherwise page into a tool that is no longer listed.
	const withinTool = (link: SidebarLink) =>
		link && belongsToTool(link, tool.slug) ? link : undefined;
	route.pagination = {
		prev: withinTool(route.pagination.prev),
		next: withinTool(route.pagination.next),
	};
});
