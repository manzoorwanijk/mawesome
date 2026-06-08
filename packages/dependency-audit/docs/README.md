# dependency-audit documentation

Reference documentation for `@mawesome/dependency-audit` — a fully-static tool that verifies every reachable bare import in a package's **released** artifact (its type `.d.ts` surface and its runtime JS surface) is **declared** in the manifest and **resolvable** through the package's own declared dependencies.

**Try it live in your browser** — audit any published npm package, nothing installed: **[the dependency-audit playground](https://mawesome.pages.dev/dependency-audit/playground/)**.

New here? **[Get started](./get-started.md)** for install and first audit. The rest of these docs go deeper, and are written to be precise enough for both humans and AI agents to rely on.

## Contents

- [Get started](./get-started.md) — install (or `npx`), run your first audit, read a finding.
- [Concepts](./concepts.md) — the bug class it catches, the two surfaces, the reachability and resolution model.
- [Why this exists](./why.md) — the Gutenberg origin story, and why isolated installs and source linters miss this bug class.
- [CLI reference](./cli.md) — every flag, exit codes, invocation patterns.
- [Output format](./output-format.md) — the exact text grammar and the `--json` schema. Read this if you parse the output (CI, an agent, a dashboard).
- [Findings & notices](./findings.md) — every finding `kind` and notice `kind`, what each means, and how to fix it.
- [Programmatic & browser API](./api.md) — `audit`, `auditPackage`, the `FileSystem` and `RegistryProvider` ports, types.
- [Resolution model](./resolution.md) — how declared deps are materialized, conditions/profiles, local (`file:`/`workspace:`/`link:`) protocols.
- [Limitations & troubleshooting](./limitations.md) — what is intentionally out of scope, and how to read common results.
- [Security](./security.md) — the static-analysis guarantees: no code execution, safe extraction, declared-range resolution.
- [Complementary tools](./comparison.md) — how it differs from and pairs with publint and attw.

## One-paragraph summary

Point the tool at a built package (a directory, a `.tgz`, or a published npm spec). It discovers the package's released entry points **from the manifest** (`exports`, `main`/`module`, `bin`, `types`/`typings`/`typesVersions`), follows the relative import graph across the shipped `.d.ts` and `.js` files, and collects every **external** bare specifier reachable on each surface. It materializes the package's **declared** dependencies fresh (from npm, or by linking a local sibling for monorepo `file:`/`workspace:` deps) into a throwaway tree — never the author's ambient `node_modules` — and resolves each specifier against that tree using TypeScript's resolver for types and Node/`exports` semantics for runtime. Anything reachable but not declared, or declared but not resolvable, is a finding. No target or dependency code is ever executed.
