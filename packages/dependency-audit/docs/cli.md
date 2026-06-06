# CLI reference

```sh
dependency-audit [options] <target...>
```

A **target** is one of:

- a **package directory** containing `package.json` (read in place — build it first);
- a local **`.tgz`** / **`.tar.gz`** tarball (extracted to a temp dir);
- a **published spec** — `name`, `name@version`, `name@tag`, `@scope/name`, `@scope/name@version`;
- an **`http(s)` tarball URL** (fetched via npm's cache/auth, integrity-verified).

Multiple targets may be passed; each is audited independently and isolated — one target failing to acquire/audit reports as an error for that target and never discards the others.

A local path that **exists but is not an auditable package** — a non-tarball file, or a directory without a `package.json` — is **skipped** (a neutral `↷` notice), not treated as an error. This is what keeps a stray glob match (`packages/*` catching a `README.md`) from turning a findings run (exit 1) into an error run (exit 2). A path that does **not** exist, or a spec that fails to resolve, is still a hard error.

## Options

| Option               | Argument          | Description                                                                                                                                                           |
| -------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--ignore <value>`   | package/specifier | Suppress findings whose **package** OR exact **specifier** equals `<value>`. Repeatable. Suppressed findings are still listed (`— ignored`) and never fail the audit. |
| `--config <path>`    | path              | Load ignore rules from a JSON config. Defaults to `./dependency-audit.config.json` if present.                                                                        |
| `--condition <name>` | condition name    | Activate an extra `exports` resolution condition (e.g. `browser`) for entry discovery **and** resolution. Repeatable.                                                 |
| `--require-types`    | —                 | Treat a coverage notice (no/unreachable type surface) as a failure (exit 1) rather than just a notice.                                                                |
| `--json`             | —                 | Emit machine-readable JSON: one entry per target. See [Output format](./output-format.md).                                                                            |
| `--no-progress`      | —                 | Suppress the stderr progress spinner even on a terminal. Also honored via the `NO_PROGRESS` env var.                                                                  |
| `-v`, `--version`    | —                 | Print the version and exit.                                                                                                                                           |
| `-h`, `--help`       | —                 | Print usage and exit.                                                                                                                                                 |

## Exit codes

| Code | Meaning                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------ |
| `0`  | Clean — no findings (and, under `--require-types`, no coverage notices).                         |
| `1`  | At least one finding (or, under `--require-types`, at least one coverage notice).                |
| `2`  | At least one target could not be audited at all (acquisition/fetch/parse error). Takes priority. |

When multiple targets are audited, the **highest** applicable exit code wins: any error → `2`; else any finding → `1`; else `0`. **Skipped** targets (non-package paths) are neutral — they never raise the exit code.

## Examples

```sh
# A built package directory
dependency-audit ./packages/my-lib

# A packed tarball
dependency-audit ./my-lib-1.2.3.tgz

# Straight from npm
dependency-audit lodash@4.17.21
dependency-audit @sindresorhus/is@latest

# A whole monorepo's built packages, machine-readable, for CI
dependency-audit --json ./packages/*

# Audit the browser export condition instead of the default Node profile
dependency-audit --condition browser ./packages/my-lib

# Treat "types not built / unreachable" as a hard failure
dependency-audit --require-types ./packages/*

# Suppress a known-intentional optional import
dependency-audit --ignore optional-plugin --ignore react/jsx-runtime ./packages/my-lib
```

## Config file

A JSON config supplies ignore rules (see [Findings & notices → ignoring](./findings.md#ignoring-intentional-findings)). By default `./dependency-audit.config.json` is read if present; `--config <path>` overrides the location.

```json
{
	"ignore": [
		{ "package": "optional-plugin" },
		{ "specifier": "react/jsx-runtime", "surface": "types" },
		{ "surface": "runtime", "kind": "unresolved" }
	]
}
```

A rule matches a finding when **every** field it sets equals the finding's; an empty rule matches nothing. CLI `--ignore` rules are merged with config rules.

## Monorepo usage

The CLI does not know about your repo layout — point it at the **built** package directories. For a pnpm/npm/yarn workspace:

```sh
pnpm -r exec dependency-audit .      # one process per package (simple, fully isolated)
dependency-audit ./packages/*        # one process, bounded-concurrency, isolated per target
```

Local `@scope/*` dependencies declared as `file:`/`workspace:`/`link:` are resolved by linking the already-built sibling, so you do not need to publish or rebuild siblings first — just build them.
