---
'@mawesome/dependency-audit': minor
---

An `undeclared` type finding for a type that isn't imported directly but leaks in through a declared dependency's API is now annotated with `leakedVia` (the producer deps), so the suggestion points at the real fix instead of telling you to declare a type you don't use.
