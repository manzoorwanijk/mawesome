---
'@mawesome/dependency-audit': patch
---

Resolve type declarations in the audit's ESM profile mode — the resolver previously probed in CJS mode, falsely flagging dependencies whose types are only reachable via the `import` condition (e.g. an adjacent `.d.ts`) as missing.
