# Output format

Two formats: a human-readable text report (default) and machine-readable JSON (`--json`). Both emit **one logical entry per target**. If you parse the output programmatically (CI gate, dashboard, AI agent), prefer `--json` — the text format is stable but optimized for reading.

All results — text and `--json` — are written to **stdout**. Progress and diagnostics go to **stderr**, so a redirect like `dependency-audit . > result.json` captures only the result. While auditing, a live progress line (current phase, deps materialized) is drawn on stderr, but only when stderr is an interactive terminal — under a pipe, a file, or CI it is silent, leaving stderr empty on a clean run.

## Text format

The report is a sequence of per-target blocks, then a summary line. Each line is prefixed with two spaces and a **status symbol**:

| Symbol | Meaning                                                                          |
| ------ | -------------------------------------------------------------------------------- |
| `✓`    | The target is clean — no findings and no notices.                                |
| `✗`    | A finding (a real problem that fails the audit).                                 |
| `ℹ`    | A notice (a coverage gap — no/unreachable type surface; does not fail).          |
| `–`    | An ignored finding (suppressed by a rule; does not fail). Ends with `— ignored`. |
| `?`    | An unchecked specifier (dynamic/opaque — surfaced, not resolved).                |
| `↷`    | A skipped target — a non-package path (does not affect the exit code).           |
| `⚠`    | An error — the target could not be audited at all.                               |
| `→`    | A remediation suggestion (continuation of the preceding `✗`/`–` line).           |

When stdout is a color-capable terminal, severity is also carried by **color** — red for findings/errors, yellow for notices/unchecked, green for clean, and muted (dim) for ignored/skipped/secondary detail. Color is auto-disabled when the output isn't a TTY (e.g. piped to a file or another program) and honors the [`NO_COLOR`](https://no-color.org) and `FORCE_COLOR` environment variables. The symbols above are the source of truth; color is purely a visual aid (and never emitted under `--json`), so parsers should key on the symbols, not the color.

### Per-target block

```
<packageName>@<version>  <target>
  [resolved: <tarball-url>]            # only for a fetched spec/URL
  [integrity: <sri>]                   # only for a fetched spec/URL
  <one or more status lines, in this order:>
    ✓ no undeclared imports            # only when fully clean
    ℹ <surface>  <message>             # notices
    ✗ <surface>  [<kind>]  <specifier>  (<file>)     # findings
        → <suggestion>
    – <surface>  [<kind>]  <specifier>  (<file>)  — ignored   # ignored findings
    ? unchecked  <specifier>  (<reason>; <file>)     # unchecked specifiers
```

- `<packageName>` falls back to the target string if the manifest has no `name`; `@<version>` is omitted if the manifest has no `version`.
- `<surface>` is `types` or `runtime`; `<kind>` is a [finding kind](./findings.md#findings); `<specifier>` is the **full** bare specifier as written (e.g. `react/jsx-runtime`), not just the owning package; `<file>` is the package-relative path where it was first seen.
- Columns are space-padded for alignment; treat **runs of whitespace as a single separator** when parsing.

### Error / skip block

```
<target>
  ⚠ error  <message>      # could not be audited
<target>
  ↷ skipped  <reason>     # a non-package path (neutral)
```

### Summary line

```
<N> package[s], <F> finding[s][, <G> ignored][, <C> notice[s]][, <S> skipped][, <E> error[s]].
```

The `ignored`, `notice`, `skipped`, and `error` clauses appear only when their count is non-zero. `<F>` counts non-ignored findings.

## JSON format (`--json`)

A single JSON array, one element per target, in input order. Each element is an **AuditResult**, an **error entry** (could not audit), or a **skip entry** (a non-package path).

### Error and skip entries

```json
{ "target": "<target>", "error": "<message>" }
{ "target": "<target>", "skipped": "<reason>" }
```

Distinguish the three by key: an `error` key → could not audit (exit 2); a `skipped` key → a neutral non-package path; otherwise it is an AuditResult (use `ok`).

### AuditResult

```jsonc
{
	"target": "./packages/my-lib", // the target as passed in
	"source": {
		// how it was acquired
		"kind": "directory", // "directory" | "tarball" | "spec"
		"resolved": {
			// present only for a fetched spec/URL
			"name": "my-lib",
			"version": "1.2.3",
			"tarball": "https://registry.npmjs.org/my-lib/-/my-lib-1.2.3.tgz",
			"integrity": "sha512-…",
		},
	},
	"packageName": "my-lib", // string | undefined (from the manifest)
	"packageVersion": "1.2.3", // string | undefined
	"ok": false, // true when findings is empty (notices do not affect ok)
	"findings": [
		{
			"specifier": "react", // the bare specifier as written
			"packageName": "react", // the normalized owning package
			"surface": "types", // "types" | "runtime"
			"kind": "undeclared", // see Findings & notices
			"firstSeenIn": "dist/index.d.ts", // package-relative path
			"suggestion": "declare \"@types/react\" …",
		},
	],
	"ignored": [
		/* Finding[] suppressed by an ignore rule, same shape */
	],
	"unchecked": [
		{ "specifier": "…", "reason": "dynamic specifier", "firstSeenIn": "dist/index.js" },
	],
	"notices": [{ "kind": "types-not-built", "surface": "types", "message": "…" }],
	"resolvedDeps": [
		{ "name": "react", "range": "^18.0.0", "version": "18.3.1" }, // version: string | undefined if it could not be materialized
	],
}
```

### Field reference

| Field             | Type                                     | Notes                                                                                            |
| ----------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `target`          | string                                   | The target as passed on the CLI / to `audit()`.                                                  |
| `source.kind`     | `"directory"` \| `"tarball"` \| `"spec"` | How the target was acquired.                                                                     |
| `source.resolved` | object \| absent                         | Present only for a fetched spec/URL; records the moving target's identity + SRI.                 |
| `packageName`     | string \| undefined                      | From the target manifest.                                                                        |
| `packageVersion`  | string \| undefined                      | From the target manifest.                                                                        |
| `ok`              | boolean                                  | `true` ⇔ `findings` is empty. **Notices and unchecked do not affect `ok`.**                      |
| `findings`        | Finding[]                                | Non-ignored problems. See [Findings](./findings.md#findings).                                    |
| `ignored`         | Finding[]                                | Findings suppressed by a rule, echoed for auditability.                                          |
| `unchecked`       | UncheckedSpecifier[]                     | Dynamic/opaque specifiers static analysis could not resolve.                                     |
| `notices`         | Notice[]                                 | Coverage gaps. See [Notices](./findings.md#notices).                                             |
| `resolvedDeps`    | ResolvedDependency[]                     | Every declared dep and the version materialized (`undefined` if it could not be fetched/linked). |

### Consuming the JSON

- **Pass/fail per target:** `entry.error !== undefined` → could not audit; `entry.skipped !== undefined` → a non-package path (neutral, ignore for pass/fail); else `entry.ok` → pass/fail on findings.
- **Coverage:** count `entry.notices` to report "audited N, M with no analyzable type surface". Treat as failure only if you opt into `--require-types` (CLI) or check `notices.length` yourself (API).
- **Aggregate exit semantics** mirror the CLI: any error entry → 2; else any `ok === false` → 1; else 0. Skip entries are neutral.
