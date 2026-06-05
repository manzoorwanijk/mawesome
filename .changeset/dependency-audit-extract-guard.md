---
'@mawesome/dependency-audit': minor
---

Bound tarball extraction with a decompression-bomb guard. Acquisition and dependency
materialization now fetch the tarball via `pacote.tarball` (preserving integrity
verification) and extract it through a streaming guard that skips symlink/hardlink entries
and aborts once the cumulative uncompressed size or entry count exceeds a cap — so a small
hostile `.tgz`/URL can't expand without limit. Defaults are 512 MB / 100k entries,
overridable via `audit(target, { extractLimits })`; `ExtractLimits`, `ExtractLimitError`,
and `DEFAULT_EXTRACT_LIMITS` are exported. The audit remains fully static (no target/dep
code is executed).
