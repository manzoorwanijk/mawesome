---
'@mawesome/dependency-audit': minor
---

A `missing-types` finding is now refined to a distinct `types-unavailable` kind when a registry probe finds no `@types/*` companion exists — so the gap is reported as genuinely unfixable-by-declaring rather than suggesting a package that does not exist. The probe is an optional `RegistryProvider.packageExists` capability (implemented by the default provider) that degrades to the conservative `missing-types` when the registry can't be reached.
