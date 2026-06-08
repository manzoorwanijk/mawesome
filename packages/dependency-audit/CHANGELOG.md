# @mawesome/dependency-audit

## 0.2.2

### Patch Changes

- [#24](https://github.com/manzoorwanijk/mawesome/pull/24) [`74a3443`](https://github.com/manzoorwanijk/mawesome/commit/74a3443032afa065dfd38cea147050af9274c043) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - The CLI now prints a `dependency-audit vX.Y.Z` banner, and wraps `--json` output in a `{ tool, version, results }` envelope.

- [#22](https://github.com/manzoorwanijk/mawesome/pull/22) [`ca132ef`](https://github.com/manzoorwanijk/mawesome/commit/ca132ef1c55d271b1649208362fcf82de968f33c) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Trim the README to a quick start, moving detailed reference into `docs/`, and add npx usage.

## 0.2.1

### Patch Changes

- [#14](https://github.com/manzoorwanijk/mawesome/pull/14) [`46d251e`](https://github.com/manzoorwanijk/mawesome/commit/46d251e5fa85e16b6b7a32d3f9eda80b01ba5f4e) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Link the live in-browser playground from the README.

- [#16](https://github.com/manzoorwanijk/mawesome/pull/16) [`9eab715`](https://github.com/manzoorwanijk/mawesome/commit/9eab715af4175c7387e267d02c46a2e4e7144d7c) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Show a live progress indicator on stderr while auditing.

## 0.2.0

### Minor Changes

- [#7](https://github.com/manzoorwanijk/mawesome/pull/7) [`e441ec6`](https://github.com/manzoorwanijk/mawesome/commit/e441ec656c606546f1cc1bec9223eff8496b5c8f) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Colorize the default CLI output by severity. Auto-disabled when stdout isn't a TTY (or under `--json`); honors `NO_COLOR` / `FORCE_COLOR`.

### Patch Changes

- [#12](https://github.com/manzoorwanijk/mawesome/pull/12) [`85ca3a8`](https://github.com/manzoorwanijk/mawesome/commit/85ca3a81d8cbfa04a35510041b2b5aaab8fac1d6) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Harden the exit flush so a broken pipe (e.g. `--json | head`) can't crash or hang the process via an `EPIPE`.

- [#8](https://github.com/manzoorwanijk/mawesome/pull/8) [`3f3c858`](https://github.com/manzoorwanijk/mawesome/commit/3f3c8589e674a571eb09534eeaad593df3242c0a) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Don't lose `--json` output on a late crash or a truncating pipe: a stray background rejection is logged (not fatal) so the run still writes its result, and exit flushes stdout first.

## 0.1.0

### Minor Changes

- [#2](https://github.com/manzoorwanijk/mawesome/pull/2) [`35b80fb`](https://github.com/manzoorwanijk/mawesome/commit/35b80fba5d669901d53e1d5bedb95c2f56bba72f) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Initial release.
