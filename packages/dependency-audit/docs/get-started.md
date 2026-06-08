# Get started

Install as a dev dependency, or run it without installing for a one-off audit of a published package:

```sh
pnpm add -D @mawesome/dependency-audit
npx @mawesome/dependency-audit lodash@4.17.21
```

## Audit a package

Point the CLI at a built package directory, a packed tarball, or a published npm spec:

```sh
# A built package directory or a packed tarball
dependency-audit ./packages/my-lib
dependency-audit ./my-lib-1.2.3.tgz

# Straight from npm — by version, tag, or scope
dependency-audit lodash@4.17.21
dependency-audit @sindresorhus/is@latest

# Several at once; machine-readable output for CI
dependency-audit --json ./packages/a ./packages/b
```

A finding looks like this — the package that imports it, the surface, the kind, where it was reached, and a concrete fix:

```
@acme/widget@1.2.3  ./packages/widget
  ✗ types      [undeclared]     react  (dist/index.d.ts)
      → declare "@types/react" (or "react" if it ships its own types)

1 package, 1 finding.
```

Exit codes: `0` clean, `1` findings, `2` error. See the [CLI reference](./cli.md) for every flag, and [findings & notices](./findings.md) for what each finding means.

## From code

The same audit is available programmatically — see the [API reference](./api.md):

```ts
import { audit } from '@mawesome/dependency-audit';

const result = await audit('./packages/my-lib');
if (!result.ok) {
	for (const finding of result.findings) {
		console.error(`${finding.packageName}: ${finding.suggestion}`);
	}
}
```

## Next steps

- [Concepts](./concepts.md) — the bug class it catches and the two surfaces it checks. Start here to understand _why_ a finding fires.
- [CLI reference](./cli.md) — every flag, exit codes, monorepo invocation patterns.
- [Findings & notices](./findings.md) — every finding and notice kind, and how to fix each.
