---
'@mawesome/dependency-audit': minor
---

A directory audit now scans only npm's publish set (via `npm-packlist`), so references in files `npm publish` excludes are no longer flagged — matching a packed `.tgz`.
