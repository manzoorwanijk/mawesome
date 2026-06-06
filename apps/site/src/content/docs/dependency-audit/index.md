---
title: dependency-audit
description: Verify every reachable bare import in a package's released artifact is declared and resolvable.
---

`@mawesome/dependency-audit` verifies that every reachable bare import in a package's **released** artifact (its type `.d.ts` surface and its runtime JS surface) is declared in the manifest and resolvable through the package's own declared dependencies.

:::note[Placeholder]
This overview is a stub. In **Phase 1** the full docs are sourced directly from `packages/dependency-audit/docs/` (single source of truth), and in **Phase 3** the live in-browser playground lands at `/dependency-audit/playground`.
:::

```sh
npx @mawesome/dependency-audit ./packages/my-lib
```
