# mawesome

A pnpm monorepo for publishing packages under the `@mawesome/*` scope, with a strict, modern, all-oxc toolchain.

📖 **Docs & interactive playgrounds:** **[mawesome.pages.dev](https://mawesome.pages.dev)** — try the tools in your browser, no install.

## Toolchain

- **pnpm 10** workspaces with supply-chain hardening (3-day release cooldown, blocked dependency build scripts, no hoisting, no root dependencies).
- **oxlint** + **oxfmt** (oxc) for linting and formatting.
- **syncpack** for dependency-version consistency (one version per dependency + `workspace:*`).
- **tsgo** (`@typescript/native-preview`) for fast type-checking.
- **tsdown** (rolldown + oxc) for dual ESM/CJS package builds with `.d.ts`.
- **vitest** for tests; **attw** + **publint** for publish hygiene.
- **changesets** + GitHub Actions for releases (npm OIDC trusted publishing).

## Packages

| Package                                                     | Description                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@mawesome/dependency-audit`](./packages/dependency-audit) | Verify every reachable import in a package's released artifact is declared and resolvable. ([npm](https://www.npmjs.com/package/@mawesome/dependency-audit) · [docs](https://mawesome.pages.dev/dependency-audit/) · [playground](https://mawesome.pages.dev/dependency-audit/playground/)) |

Add another with `/add-package` or by copying `templates/package/`.

## Quickstart

```sh
# Requires Node >=24.12 and pnpm 10 (see CONTRIBUTING.md).
pnpm install
pnpm verify   # lint, format, deps, typecheck, test, build, exports — the full gate
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the add-a-package recipe and release flow, and [AGENTS.md](./AGENTS.md) for the authoritative command and rule reference (it applies to human contributors and AI agents alike).

## License

[MIT](./LICENSE) © 2026 Manzoor Ahmad Wani
