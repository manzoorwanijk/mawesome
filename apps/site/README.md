# @mawesome/site

The documentation + playground site for the `@mawesome/*` tools — an Astro + Starlight static site deployed to Cloudflare Pages. It is private (never published to npm).

See the repo [AGENTS.md](../../AGENTS.md) for monorepo-wide conventions.

## Local development

The site bundles `@mawesome/dependency-audit/browser`, which resolves to that package's **built** `dist/`. So build the workspace packages once before working on the site (a clean `dist` is gitignored):

```sh
pnpm build:packages                    # build the packages the site depends on
pnpm --filter @mawesome/site dev      # dev server at http://localhost:4321
pnpm --filter @mawesome/site preview   # serve a built dist locally
```

For a full build, prefer `pnpm build` from the repo root: pnpm runs workspace builds in topological order, so `@mawesome/dependency-audit` builds before this site. (A targeted `--filter @mawesome/site build` does **not** build its dependency first — use the root `pnpm build`.)

## How it fits together

- **Docs are aggregated, not authored here.** Each tool's docs live in `packages/<tool>/docs/*.md` (the single source of truth). `scripts/sync-docs.ts` copies them into `src/content/docs/<tool>/` (gitignored) on every `dev`/`build`/`typecheck`, deriving titles and rewriting links. Edit the docs in the package, not the generated copies.
- **`src/tools.ts` is the tool registry.** Adding an entry (with a `packages/<slug>/docs/` directory) surfaces the tool in the homepage cards, the sidebar, and — if `playground: true` — a `/<slug>/playground/` route. A docs-only tool just sets `playground: false`.
- **The playground runs entirely in the browser.** `src/lib/dependency-audit/engine.ts` resolves a package version (jsDelivr), fetches the published tarball from npm, extracts it into an in-memory filesystem, and runs the `@mawesome/dependency-audit/browser` core. The core (which pulls in TypeScript) is dynamically imported, so its chunk only loads when an audit runs.

## Deploying to Cloudflare Pages

Connect the repository in the Cloudflare dashboard with these settings:

| Setting                | Value                                                     |
| ---------------------- | --------------------------------------------------------- |
| Production branch      | `main`                                                    |
| Root directory         | `/` (repo root — needed for the pnpm workspace)           |
| Build command          | `pnpm build` (topological — builds the package dep first) |
| Build output directory | `apps/site/dist`                                          |
| Node version           | from `.nvmrc` (24)                                        |

Notes:

- Cloudflare installs dependencies with pnpm automatically (it honors the `packageManager` field). The repo pins pnpm with `packageManagerStrictVersion`, so the build image must provide that pnpm version; if it doesn't, prefix the build command with a standalone pnpm install.
- No environment variables are required. Cloudflare provides `CF_PAGES_URL` (used for the site's canonical/sitemap URLs) and `CF_PAGES_BRANCH` (used for doc "Edit page" links) automatically.
- Pull requests get per-branch preview deployments. The PR CI runs `pnpm verify`, whose `build` step builds this site too, so bundling regressions are caught before a deploy. (The release publish job uses `pnpm build:packages`, which skips apps.)
