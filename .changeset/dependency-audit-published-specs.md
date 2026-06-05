---
'@mawesome/dependency-audit': minor
---

Audit published packages directly: a target can now be a published spec
(`name@version`, `name@tag`, `@scope/name`) or an `http(s)` tarball URL, in addition to a
local directory or `.tgz`. Specs are fetched and extracted via pacote (reusing npm's
cache/auth/dist-tag resolution). The result records how the target was acquired in a new
`source` field, including the resolved tarball URL and integrity for fetched specs (a tag
is a moving version), surfaced in both text and `--json` output.
