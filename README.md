# mawesome

A pnpm monorepo for publishing packages under the `@mawesome/*` scope, with a strict, modern, all-oxc toolchain.

## Toolchain

- **pnpm 10** workspaces with supply-chain hardening (3-day release cooldown, blocked dependency build scripts, no hoisting, no root dependencies).
- **oxlint** + **oxfmt** (oxc) for linting and formatting.
- **syncpack** for dependency-version consistency (one version per dependency + `workspace:*`).
- **tsgo** (`@typescript/native-preview`) for fast type-checking.
- **tsdown** (rolldown + oxc) for dual ESM/CJS package builds with `.d.ts`.
- **vitest** for tests; **attw** + **publint** for publish hygiene.
- **changesets** + GitHub Actions for releases (npm OIDC trusted publishing).

## Packages

| Package    | Description                                                       |
| ---------- | ----------------------------------------------------------------- |
| _none yet_ | _Add one with `/add-package` or by copying `templates/package/`._ |

## Quickstart

```sh
# Requires Node >=24.12 and pnpm 10 (see CONTRIBUTING.md — no Corepack).
pnpm install
pnpm verify   # lint, format, deps, typecheck, test, build, exports — the full gate
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the add-a-package recipe and release flow, and [AGENTS.md](./AGENTS.md) for the authoritative command and rule reference (it applies to human contributors and AI agents alike).

## License

[MIT](./LICENSE) © 2026 Manzoor Ahmad Wani
