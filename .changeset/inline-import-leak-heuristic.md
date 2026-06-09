---
'@mawesome/dependency-audit': minor
---

`leakedVia` is now attributed only to a type that appears solely as a synthesized inline `import("x")`, not to a package you import directly — so a genuine direct import is no longer mislabeled as leaked through a dependency.
