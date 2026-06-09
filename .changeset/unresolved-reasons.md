---
'@mawesome/dependency-audit': minor
---

Runtime `unresolved` findings now carry a `reason` (`subpath-not-exported`, `file-missing`, or `condition-mismatch`) naming the specific cause — notably flagging an ESM/CJS export-condition mismatch (a `require` of an `import`-only package, or vice-versa) instead of a generic "does not resolve".
