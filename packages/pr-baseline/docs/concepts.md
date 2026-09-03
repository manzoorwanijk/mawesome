# Concepts

## The baseline

A **baseline** is a lightweight git tag on the base branch that marks the last commit every open pull request must contain. It moves forward only, and only by intent:

- a `move-baseline --force` (a workflow dispatch, in the action),
- a merged pull request carrying the baseline's **label**,
- a push to the base branch touching one of the baseline's **markers** (gitignore-style path patterns).

The tool never force-updates the tag. Every move goes through GitHub's ref API with `force: false`, so the server enforces a fast-forward. A rewind is an operator action: delete the tag and seed it again.

## Verdicts

For a commit, the verdict is `pass` when every applicable baseline is an ancestor of it and `fail` otherwise. An absent tag counts as satisfied, so a repository can adopt the tool before seeding anything. One commit status carries the combined verdict; the failing description names the missing baselines.

Two other passes exist: **not applicable**, written only with `--other-bases pass` for a PR targeting another branch, and **misconfigured**, written by `check` when a baseline is no longer on the base branch, so an operator mistake never blocks an author. In that state `sweep` refuses to write anything and `report` prints the problem; both exit 2.

## Scope

Only PRs whose base is the configured branch are evaluated and stamped. A commit status belongs to a SHA and a context, not to a PR, so writing a verdict for an out-of-scope PR could leak onto an in-scope one sharing the same head. Read [edge cases](./edge-cases.md) before switching `--other-bases` to `pass`.

## Several baselines

A repository may define several baselines, each `{ tag, label?, scope?, markers? }`:

- `scope` decides which PRs the baseline binds: those whose diff against the base branch touches a scope pattern. Absent means every PR.
- `markers` decides when a base push moves the baseline automatically. Absent means only its label and a forced move do.
- `label` names the label whose merged PRs move the baseline. Several baselines may share one label.

The two are independent: a repository-wide baseline can move only when `.nvmrc` changes, and a per-package baseline can bind only that package's PRs while moving on its own toolchain files. Both use gitignore grammar through the `ignore` package, applied to changed filenames, so git and API decisions cannot diverge.

## Idempotency

A sweep recomputes every in-scope PR's verdict and writes only when the existing status differs in state, description, target URL or creator. The description is human text and encodes no SHA. A status written by another creator (an old token, a previous integration) is rewritten, so a ruleset pinned to a source is always satisfied by the configured token.

## Recovery

A sweep that hits a rate limit or a write budget exits nonzero with a summary and a retry hint; the next scheduled run continues where it left off, since every write it made is already current. Scheduled runs are best effort on GitHub, so a workflow dispatch is the immediate retry and `report` tells an operator whether anything is still stale.
