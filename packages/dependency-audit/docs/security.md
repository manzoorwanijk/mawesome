# Security

The audit is **fully static**: tarballs are only _extracted_ and files only _parsed_ — no target or dependency code is ever executed (no install scripts run).

- **No code execution.** Neither the target nor any materialized dependency is installed or run; nothing in `scripts` (`prepare`/`postinstall`/…) executes.
- **Integrity-verified fetches.** Registry fetches verify integrity, and the resolved tarball URL + SRI are reported on the result.
- **Safe extraction.** Extraction skips symlink/hardlink entries and blocks path traversal, runs in throwaway temp dirs, and is bounded by a decompression-bomb guard (`maxBytes` / `maxEntries`, overridable via `audit(target, { extractLimits })`).
- **Declared-range resolution.** Resolution runs against the target's _declared_ ranges in a fresh tree, never the author's ambient `node_modules`.

## Fetching tarballs by URL

When pointing the tool at an untrusted `http(s)` tarball URL — e.g. caller-supplied input in a service context — treat it as you would any fetch-by-URL: the _compressed_ download size is not separately capped (registry artifacts are size-bounded by npm), and SSRF is the caller's responsibility.
