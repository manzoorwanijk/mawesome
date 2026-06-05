---
'@mawesome/dependency-audit': minor
---

Resolve monorepo-local dependencies. A declared dep with a `file:` range (resolved relative to the audited package) or a `workspace:` range (pnpm/yarn — resolved by name through `pnpm-workspace.yaml` or `package.json#workspaces`) now materializes by symlinking the local, already-built sibling package — no rebuild, fully static — instead of failing as a registry lookup. This makes the tool work on a monorepo package as-is (including unpublished local changes); previously every `file:`/`workspace:` dep produced false `unresolved`/`missing-types` findings. The default provider gains a `where` option (the audited package dir) via `createPacoteProvider({ where })`.
