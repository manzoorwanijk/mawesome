# Limitations & troubleshooting

The tool aims for **correct, narrow** results: when it reports a finding it is real, and it prefers a notice or an `unchecked` entry over a guess. The trade-off is coverage — these are the known boundaries.

## Known limitations

- **Audits the artifact you point at, not a publish-equivalent pack.** A directory target is read **in place**; the tool does not run `npm pack` or apply `files`/`.npmignore`, and does not run `prepack`/`prepare` (it never executes your code). So scan the **built** output, and be aware that files npm would exclude are still on disk. (Audit a `.tgz` you packed yourself for an exactly-published file set.)
- **`typesVersions` is applied for the current TypeScript version only** — the version running inside the tool — not the full per-consumer-version matrix.
- **The type surface resolves a single ESM/NodeNext profile.** There is no per-file `require`-context type resolution and no `bundler`-mode type pass; one profile (plus any `--condition`) is checked.
- **The legacy `browser` field remap is not applied** — only the `browser` export **condition** (`--condition browser`). Object/`false`-shim `browser` field rewrites are out of scope.
- **Self-reference (`name`/`name/subpath`) and subpath `#imports` specifiers are skipped** — they are resolved internally by the package, not external dependencies.
- **Dynamic/non-literal specifiers are unchecked, not resolved** — a dynamic `import(variable)`, a templated `require()` call, a `createRequire` result stored in a variable. They appear in `result.unchecked`.
- **The compressed download size of an `http(s)` tarball URL is not separately capped** (the _uncompressed_ extraction is bomb-guarded; registry artifacts are size-bounded by npm). SSRF for caller-supplied URLs is the caller's responsibility. See [Security](../README.md#security).

## Troubleshooting

### "It reports all clean, but a package I expected wasn't really checked."

Look for an `ℹ` notice on that package. A [`types-not-built`](./findings.md#notices) notice means its type surface was empty because the build output is missing — **build it first**. A `types-unreachable` notice means it ships `.d.ts` but no `types`/`exports` condition exposes them. A package that legitimately has no types (a Babel/PostCSS plugin) correctly shows nothing. Use `--require-types` to make missing/unreachable types a hard failure across a monorepo.

### "A finding points at a subpath I'm sure exists."

An `unresolved` runtime finding means the **declared dependency's own `exports`** does not expose that subpath for the call form used (or the target file is absent in the materialized version). Check the dependency's `exports` for that subpath and the version your range resolved to (`resolvedDeps`).

### "A whole target errored (`⚠`)."

The target could not be acquired or parsed: a path that does not exist, a spec that does not resolve on the registry, a network/auth failure, or a corrupt tarball. The error message says which. Other targets in the same run are unaffected. (An error sets exit 2.)

### "A target was skipped (`↷`)."

The path exists but is not an auditable package — a non-tarball file, or a directory without a `package.json` (e.g. a `packages/*` glob matching a `README.md`). Skips are **neutral**: they never raise the exit code, so a stray glob match cannot turn a findings run (exit 1) into an error run (exit 2). Point the tool at built package directories, or use a more specific glob (`packages/*/`) if you would rather not see the skips.

### "`--json > result.json` produced an empty file."

The CLI writes the `--json` array once, after every target finishes, and flushes before exiting (so a redirect/pipe is never truncated). If a stray background error from the registry client surfaces mid-run it is logged to stderr as `warning: ignored a background error — …` and the audit still completes and writes its result — it no longer crashes the whole run. If `result.json` is still empty, the process was killed by something outside the tool's control (out of memory, `ulimit` file-descriptor exhaustion on a very large batch); reduce the number of targets per invocation (e.g. audit in chunks) and check stderr.

### "Running the CLI from inside the package prints 'no such file'."

Invoke the built bin with a path that exists from your current directory — e.g. `node dist/cli.js .` or `./dist/cli.js .` from the package root, not `packages/x/dist/cli.js .` while already inside `packages/x`.

### "A type leaks but `devDependencies` has it — why a finding?"

If a type appears in your **published** `.d.ts`, a consumer must resolve it, so its package must be a non-dev dependency (`dependencies`, or `peerDependencies` for a shared type). A `devDependencies`-only declaration does not reach consumers and is correctly flagged.
