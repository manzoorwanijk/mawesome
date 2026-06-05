# Complementary tools

`dependency-audit` is deliberately narrow: it answers **"does the released artifact declare and resolve every package it imports?"** Three checks belong in a pre-publish gate, and they barely overlap. Run all three.

## At a glance

| Tool                                                                                                 | Question it answers                                                                | Representative catches                                                                                                                    |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [**publint**](https://publint.dev)                                                                   | Is the **manifest** well-formed for publishing?                                    | bad `exports`/`main`/`types` paths, files missing from the package, wrong extensions, `module` mistakes                                   |
| [**attw**](https://github.com/arethetypeswrong/arethetypeswrong.github.io) (`@arethetypeswrong/cli`) | Do **your own** types resolve correctly across module-resolution modes?            | `.d.ts` resolvable under ESM but not CJS, masquerading CJS/ESM, a missing type entry point                                                |
| **dependency-audit**                                                                                 | Do the imports in the released artifact resolve through **declared dependencies**? | a `.d.ts` `import('react')` with no `@types/react`; a runtime `require('x')` of an undeclared dep; a deep import of an unexported subpath |

## Why they don't overlap

- **publint** validates the **shape** of your package — does the manifest point at files that exist, with the right extensions and conditions? It does not install dependencies or follow your import graph.
- **attw** validates that **your** declarations are **consumable** — does `import 'your-pkg'` give a consumer working types under node16-CJS, node16-ESM, and bundler resolution? It checks resolution **into** your package, not the dependencies your package reaches **outward**.
- **dependency-audit** validates **dependency completeness of the reachable surface** — it materializes your declared deps and confirms every bare import in your shipped `.d.ts`/JS resolves through them. It does not judge your manifest's packaging shape or your own types' cross-mode correctness.

A package can pass publint (manifest is fine) **and** attw (its own types resolve) and still ship a `.d.ts` that imports an **undeclared transitive** — the exact gap dependency-audit closes. Conversely, dependency-audit will not tell you your `exports` point at a non-existent file (publint will) or that your types break under CJS (attw will).

## Suggested gate

```sh
publint --strict                 # manifest/packaging hygiene
attw --pack .                    # your types resolve across modes
dependency-audit .               # reachable imports are all declared & resolvable
```

This repository runs publint + attw on every package via `pnpm check:exports`, and dogfoods `dependency-audit` on itself. If you adopt only one of the three, still try the others — each is quick and catches a different class of "works on my machine" bug.

## Related, broader tools

- **depcheck / knip** — find **unused** dependencies and dead files across your **source** tree. dependency-audit is the dual: it finds **undeclared** dependencies in the **released** artifact, resolving against declared ranges rather than scanning source. Use both: knip to prune, dependency-audit to confirm what remains is complete and installable.
