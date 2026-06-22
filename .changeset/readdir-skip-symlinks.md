---
'@mawesome/dependency-audit': patch
---

Fix an out-of-memory crash when auditing a package whose `node_modules` links into a shared store (e.g. pnpm's or npm with install-strategy=linked).
