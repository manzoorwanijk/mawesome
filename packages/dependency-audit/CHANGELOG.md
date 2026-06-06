# @mawesome/dependency-audit

## 0.2.0

### Minor Changes

- [#7](https://github.com/manzoorwanijk/mawesome/pull/7) [`e441ec6`](https://github.com/manzoorwanijk/mawesome/commit/e441ec656c606546f1cc1bec9223eff8496b5c8f) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Colorize the default CLI output by severity. Auto-disabled when stdout isn't a TTY (or under `--json`); honors `NO_COLOR` / `FORCE_COLOR`.

### Patch Changes

- [#12](https://github.com/manzoorwanijk/mawesome/pull/12) [`85ca3a8`](https://github.com/manzoorwanijk/mawesome/commit/85ca3a81d8cbfa04a35510041b2b5aaab8fac1d6) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Harden the exit flush so a broken pipe (e.g. `--json | head`) can't crash or hang the process via an `EPIPE`.

- [#8](https://github.com/manzoorwanijk/mawesome/pull/8) [`3f3c858`](https://github.com/manzoorwanijk/mawesome/commit/3f3c8589e674a571eb09534eeaad593df3242c0a) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Don't lose `--json` output on a late crash or a truncating pipe: a stray background rejection is logged (not fatal) so the run still writes its result, and exit flushes stdout first.

## 0.1.0

### Minor Changes

- [#2](https://github.com/manzoorwanijk/mawesome/pull/2) [`35b80fb`](https://github.com/manzoorwanijk/mawesome/commit/35b80fba5d669901d53e1d5bedb95c2f56bba72f) Thanks [@manzoorwanijk](https://github.com/manzoorwanijk)! - Initial release.
