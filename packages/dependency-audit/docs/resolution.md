# Resolution model

How specifiers are resolved against the target's **declared** dependencies — the heart of what makes the audit accurate.

## Which dependencies are materialized

The tool materializes the manifest's **production**, **peer**, and **optional** dependencies — never `devDependencies` (a consumer does not get those). Each is materialized at its declared range into one fresh `node_modules` tree shared by both surfaces, with bounded concurrency so a large batch does not overwhelm the registry cache.

`resolvedDeps` on the result records every declared dep and the `version` actually materialized (`undefined` if it could not be fetched/linked — references to it then fail to resolve and surface as findings).

## Where dependencies come from

| Declared range                                     | How it is materialized                                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `^1.2.3`, `~1.0`, `1.x`, `*`, `latest`             | Fetched from npm at the highest satisfying version via pacote (reusing npm cache/auth), integrity-verified, bomb-guard-extracted. |
| `npm:alias@^1`                                     | Registry fetch of the aliased package.                                                                                            |
| `file:../sibling` (directory)                      | **Linked** to the local directory (resolved relative to the audited package). No copy, no build.                                  |
| `file:../pkg.tgz`                                  | Extracted (bomb-guarded).                                                                                                         |
| `link:../sibling`                                  | **Linked**, same as a `file:` directory.                                                                                          |
| `workspace:*` / `workspace:^` / `workspace:name@*` | Resolved **by name** through `pnpm-workspace.yaml` or `package.json#workspaces`, then linked to the local sibling.                |

Local linking is what makes the tool work in a monorepo without publishing or rebuilding siblings: build all packages, then audit — each `@scope/*` sibling resolves to its real, already-built directory. Everything stays static; no dependency's install/build scripts ever run. A local spec is always resolved by the tool itself, so it never reaches pacote's directory packer.

## Conditions and profiles

Resolution activates a **condition set**, mirroring how a real consumer resolves `exports`. The defaults:

| Surface / profile   | Default active conditions                                 |
| ------------------- | --------------------------------------------------------- |
| Type surface        | `types`, `import`, `node`, `default` (`types` wins first) |
| Runtime — `import`  | `import`, `node`, `default`                               |
| Runtime — `require` | `require`, `node`, `default`                              |

Both runtime profiles are audited, because a dual package can expose different specifiers under `import` vs `require`; a finding reachable under only one profile is still reported.

`--condition <name>` / `options.conditions` **adds** conditions on top of these defaults — for both **entry-point discovery** (which export branch is the surface) and **resolution** (how the dependency's own `exports` are read). The common case is `--condition browser`, which audits the surface a bundler sees under the `browser` export condition. Within a conditional `exports` object, the **author's key order** is the priority (Node semantics), so an active `browser` listed before `import` wins.

> The legacy `browser` **field** remap (`{ "browser": { "./a": "./b" } }`) is **not** applied — only the `browser` export **condition** is honored.

## How each surface resolves

- **Type specifiers** go through the bundled `typescript` (`ts.resolveModuleName` and `ts.resolveTypeReferenceDirective`) under `moduleResolution: nodenext`, with `customConditions` for any extra conditions. This gives exact `@types/*` fallback (`react` → `@types/react`) and `typesVersions` handling, identical to a consumer's checker.
- **Runtime specifiers** go through the dependency's own `exports` via `resolve.exports` for the matching call form (`require` flag set for `require`-form imports), with the active extra conditions. With no `exports`, it falls back to legacy `main`/`module` plus extension/index probing (`require` probes `.js`/`.cjs`/`.mjs`/`.json` and `index.*`; `import` does not index-probe).

## Node builtins

The Node entry injects the running Node's live `builtinModules` list; the browser core uses a hardcoded default. A builtin is recognized with or without the `node:` prefix. Builtins need **no** declaration at run time; on the type surface they imply `@types/node`.
