# Findings & notices

A **finding** is a real problem that fails the audit (`ok: false`, exit 1). A **notice** is a coverage gap that does not fail by default. An **unchecked** specifier is one static analysis could not resolve (surfaced for transparency, never a failure).

## Findings

Every finding has a `surface` (`types` or `runtime`) and a `kind`:

| Kind            | Surface         | Meaning                                                                                                                                                                                      |
| --------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `undeclared`    | types / runtime | The owning package is reachable on the surface but is **not declared** in any non-dev manifest field.                                                                                        |
| `missing-types` | types           | The package **is declared** but provides **no resolvable declarations** for the specifier (the headline bug — e.g. a `.d.ts` `import('react')` with `react` declared but no `@types/react`). |
| `unresolved`    | runtime         | The package **is declared** but the specifier does **not resolve to a file** — typically a deep import of a subpath the dependency's `exports` does not expose, or a missing target file.    |

An `unresolved` finding also carries an optional **`reason`** naming the specific cause, so the diagnosis isn't a guess:

| `reason`               | Meaning                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `subpath-not-exported` | The package's `exports` map does not expose this subpath.                                                                    |
| `file-missing`         | The specifier maps to a target file that is not present.                                                                     |
| `condition-mismatch`   | It resolves under the **other** call form — a `require` (CJS) of an `import`-only `exports`, or vice-versa (ESM/CJS hazard). |

`reason` is omitted when the cause is indeterminate (e.g. the package is not in the resolution tree). Each finding also carries a `suggestion` with concrete remediation. Examples:

```
✗ types      [undeclared]     csstype  (dist/index.d.ts)
    → declare "csstype" (or "@types/csstype" if it ships no types)

✗ types      [missing-types]  react  (dist/index.d.ts)
    → "react" is declared but provides no resolvable declarations for "react"; add "@types/react" or a version that ships types

✗ runtime    [unresolved]     @wordpress/boot  (build/index.cjs)
    → "@wordpress/boot" resolves for import (ESM) but was loaded via require (CJS) — "@wordpress/boot" exposes no "require" export condition (ESM/CJS mismatch)
```

### How to fix each

- **`undeclared` (runtime):** add the package to `dependencies` (or `peerDependencies`/`optionalDependencies` if that fits its role).
- **`undeclared` (types):** add the package — or its `@types/*` companion if it ships no types of its own — to `dependencies` (runtime-needed) or `devDependencies` is **not** enough if the type leaks into your published `.d.ts`; a type a consumer must resolve has to be a non-dev dependency.
- **`missing-types`:** declare the `@types/*` package, or upgrade the dependency to a version that bundles its own declarations.
- **`unresolved`:** let the `reason` guide the fix. `subpath-not-exported` → stop importing the private subpath, or ask the dependency to add it to its `exports`. `condition-mismatch` → the dependency is missing the `require`/`import` export condition you load it under (a real dual-package bug — fix the producer, or load it under the other form). `file-missing` → the mapped target isn't shipped (build/packaging gap). If it is your own subpath that the dependency genuinely exports, it can also indicate a version mismatch in the materialized tree.

### Node builtins

A `node:`-prefixed or bare builtin (`fs`, `path`, …) needs **no** declaration at run time, so it is never a runtime finding. On the **type** surface a builtin implies `@types/node`: if a declaration references a builtin and `@types/node` is not declared, that is an `undeclared` finding suggesting `@types/node`.

## Notices

A notice means a surface had **nothing to analyze** — emitted so "audited, clean" is never confused with "nothing audited". Notices live in `result.notices`, print as `ℹ`, and do **not** fail the audit unless you pass `--require-types`.

| Kind                | Surface | Meaning                                                                                                                                                                                                                                                                     |
| ------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types-not-built`   | types   | The manifest **declares** type declarations (a `types`/`typings` field, `typesVersions`, or an `exports` `types` condition) but **none resolve** from the package root — the build output looks missing. Build the package before auditing, or fix the declared types path. |
| `types-unreachable` | types   | The package **ships `.d.ts` files** but **no manifest entry exposes them** (no `types` field, no `exports` `types` condition, and `exports` encapsulates the package). Consumers cannot resolve its types — a likely packaging gap.                                         |

A package that legitimately declares and ships no types (e.g. a Babel/PostCSS plugin) produces **no** notice. A fully-analyzed type surface produces no notice.

### `--require-types`

Pass `--require-types` (CLI) to promote any coverage notice to a failure (exit 1) — useful in a monorepo gate where every TypeScript package is expected to ship resolvable types. Programmatically, inspect `result.notices.length` yourself.

## Unchecked specifiers

A specifier whose value is not a literal — a dynamic `import(someVariable)`, a templated `require()` call, a `createRequire` result stored in a variable — cannot be statically resolved. Rather than drop it (a silent false negative), the tool records it in `result.unchecked` with a `reason`, printed as `?`. Review these manually; they are not failures.

## Ignoring intentional findings

Some findings are intentional — an optional/plugin import the code guards at run time, or a specifier static analysis cannot prove is fine. Suppress them with ignore rules (CLI `--ignore`, or a [config file](./cli.md#config-file)). Suppressed findings move to `result.ignored`, still print (`— ignored`), and never fail the audit — so suppressions stay auditable.

An **IgnoreRule** matches a finding when **every** field it sets equals the finding's; an empty rule matches nothing:

```jsonc
{ "package": "optional-plugin" }                          // any finding for this package
{ "specifier": "react/jsx-runtime", "surface": "types" }  // this exact specifier, on the type surface
{ "surface": "runtime", "kind": "unresolved" }            // all unresolved runtime findings
```

`package`/`specifier`/`surface`/`kind` match the finding itself. Two optional fields **scope** a rule, so a localized suppression can't also hide a real regression of the same specifier in another package:

- **`target`** — restricts the rule to one audited target. It matches that target's package **name** (most reliable — e.g. `my-pkg`) **or** the target string **exactly as passed** to the audit (a directory, `.tgz` path, or spec). The spec form is not path-normalized, so prefer the package name when you can.
- **`path`** — a glob over the finding's package-relative `firstSeenIn`. A `path` rule alone applies in **every** target (it scopes by location, not by package); combine it with `target` to scope to one package's files.

Glob syntax (the common gitignore subset): `*` matches within a single path segment, `?` matches one non-`/` character, and `**` is a globstar only as a whole segment — a leading/inner `**/` matches zero or more segments (`**/x` matches `x` and `a/b/x`), and a trailing `/**` matches all descendants (`fixtures/**` matches `fixtures/x` but not `fixtures` itself).

```jsonc
{ "target": "my-pkg", "path": "fixtures/**", "specifier": "x" } // only in my-pkg's fixtures
```

A CLI `--ignore <value>` is shorthand for "match `package === value` OR `specifier === value`" (an unscoped, global rule); use a config file for `target`/`path` scoping.
