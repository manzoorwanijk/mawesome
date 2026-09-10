# mawesome

A monorepo of sharp, single-purpose developer tools.

📖 Docs and playgrounds: **[mawesome.pages.dev](https://mawesome.pages.dev)**

## Tools

| Tool                                                        | What it does                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@mawesome/dependency-audit`](./packages/dependency-audit) | Verify every reachable import in a package's released artifact is declared and resolvable. ([npm](https://www.npmjs.com/package/@mawesome/dependency-audit) · [docs](https://mawesome.pages.dev/dependency-audit/) · [playground](https://mawesome.pages.dev/dependency-audit/playground/)) |

## Quickstart

```sh
# Requires Node >=24.12 and pnpm 10 (see CONTRIBUTING.md).
pnpm install
pnpm verify   # lint, format, deps, typecheck, test, build, exports: the full gate
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) to get started. [AGENTS.md](./AGENTS.md) is the authoritative command and rule reference, for humans and AI agents alike.

## License

[MIT](./LICENSE) © 2026 Manzoor Ahmad Wani
