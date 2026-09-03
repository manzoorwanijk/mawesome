# CLI reference

```
pr-baseline <command> [options]
```

Commands: `check`, `sweep`, `move-baseline`, `report`. The repository, token and API URLs have environment fallbacks; every other option is a flag, and the action maps its inputs onto them. A flag always wins over the environment.

## Global options

| Option                                | Env                  | Default                                     | Meaning                                                                                                                               |
| ------------------------------------- | -------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `--repo <owner/name>`                 | `GITHUB_REPOSITORY`  | required                                    | Repository.                                                                                                                           |
| `--token <token>`                     | `GITHUB_TOKEN`       | none                                        | Token; required for everything but usage.                                                                                             |
| `--api-url <url>`                     | `GITHUB_API_URL`     | `https://api.github.com`                    | REST root; set it for GitHub Enterprise Server (`https://HOST/api/v3`).                                                               |
| `--graphql-url <url>`                 | `GITHUB_GRAPHQL_URL` | beside `--api-url`                          | GraphQL endpoint, used as given apart from trailing slashes; derived as `https://HOST/api/graphql` from a GHES REST root when unset.  |
| `--base <branch>`                     |                      | repository default branch                   | The base branch one instance serves.                                                                                                  |
| `--baselines <json>`                  |                      | one default baseline                        | JSON array of `{ tag, label?, scope?, markers? }`; `@path` reads a file. Cannot be combined with the shorthand.                       |
| `--tag <name>`                        |                      | `pr-baseline`                               | Shorthand: the single baseline's tag.                                                                                                 |
| `--label <name>`                      |                      | `Require PR update`                         | Shorthand: the single baseline's label.                                                                                               |
| `--markers <pattern>`                 |                      | none                                        | Shorthand: auto-move patterns, repeatable.                                                                                            |
| `--baseline <tag>`                    |                      | all                                         | `move-baseline` only: restrict to one configured baseline; an unknown tag is an error.                                                |
| `--context <name>`                    |                      | `PR baseline`                               | Status context.                                                                                                                       |
| `--description-pass <text>`           |                      | `Contains the required {base} changes.`     | `{base}` and `{tags}` placeholders.                                                                                                   |
| `--description-fail <text>`           |                      | `Merge or rebase {base} to include: {tags}` | Lists two missing tags and counts the rest.                                                                                           |
| `--description-not-applicable <text>` |                      | `Baseline applies to {base} only.`          | Used only with `--other-bases pass`.                                                                                                  |
| `--target-url <url>`                  |                      | none                                        | Link on the status, for example the [PR author page](./for-pr-authors.md).                                                            |
| `--other-bases skip\|pass`            |                      | `skip`                                      | PRs against another branch: skip them, or write a not-applicable pass.                                                                |
| `--creator <login>`                   |                      | resolved                                    | Login the token writes statuses as. Required for a GitHub App token and for `GITHUB_TOKEN` used from the CLI (`github-actions[bot]`). |
| `--ancestry auto\|git\|api`           |                      | `auto`                                      | Ancestry source. `git` lands with the git adapter; until then `auto` uses the API.                                                    |
| `--git-dir <path>`                    |                      | cwd                                         | Local repository for ref resolution.                                                                                                  |
| `--offline`                           |                      | off                                         | Trust the local clone's tags without a token (git adapter).                                                                           |
| `--max-writes-per-run <n>`            |                      | `450`                                       | Stop the sweep after this many status writes.                                                                                         |
| `--max-writes-per-minute <n>`         |                      | `60`                                        | Pace status writes.                                                                                                                   |
| `--dry-run`                           |                      | off                                         | Log every intended write and tag move instead of making it.                                                                           |
| `--json`                              |                      | off                                         | Print the command's result object as JSON on stdout; logs stay on stderr.                                                             |

Descriptions are capped by GitHub at 140 characters; a long template or long tag names are truncated deterministically with an ellipsis, never rejected.

## Commands

Options listed under a command are rejected with any other command, so a misplaced flag is an error rather than silently ignored.

### `check [<sha-or-ref>]`

Evaluates one commit against every configured baseline. The commit is the positional SHA or ref, `--pr <n>` for a pull request's head, or `HEAD` of the local repository. A bare ref is resolved locally first, then through the API.

`--report` writes the status; `--no-report` suppresses it. The default is on for `--pr`, which names a commit GitHub already knows about, and off for any commit given directly, which is a local question. The action passes `report` explicitly for event SHAs. Before posting, the tags and the base head are re-read together and the verdict recomputed if either moved.

A PR targeting another branch is skipped with a notice, or stamped with the not-applicable pass under `--other-bases pass`. When any present baseline is not on the base branch, the commit receives the misconfiguration pass whatever its ancestry, so the operator error is visible on every PR without blocking anyone.

Exit codes: `0` pass (including not-applicable and misconfigured), `1` fail, `2` error.

### `sweep`

Lists open PRs against the base branch, computes every verdict, and writes only the statuses that differ in state, description, target URL or creator. Writes are paced by `--max-writes-per-minute`, capped by `--max-writes-per-run`, and stop when the primary rate limit is within its reserve.

The summary reports `written`, `skipped` (already current), `closed` (gone since listing), `deferred` (head still moving), `failed` and `incomplete` with a `reason`: `rate-limit`, `write-cap`, `primary-budget`, `deferred` or `failed`. Any `deferred` or `failed` marks the sweep incomplete. `closed` and `deferred` only occur with the git adapter; the API adapter writes to the listed head.

A permission or authentication failure on the first write stops the sweep, since it would repeat for every PR. A commit that already carries 1,000 statuses for the context fails for that PR only.

Before evaluating anything, the sweep resolves the status creator and verifies every present baseline is an ancestor of the base branch head; either failure is exit `2` and nothing is written.

Exit codes: `0` complete, `1` incomplete, `2` error.

### `move-baseline`

For each selected baseline decides whether it should move, and to where:

- `--force` moves by intent alone and seeds an absent tag. It is never a ref force.
- Otherwise a merged PR against the base carrying the baseline's label moves it when the merge commit is not the current baseline, descends from it, and is an ancestor of the target. Every merged PR with the label is scanned, newest first, with no date cutoff.
- Otherwise a change to one of the baseline's `markers` between the current baseline and the target moves it. When the compare API returns 300 files the answer is indeterminate; the tool warns and does not move automatically.

`--to <sha>` sets the target instead of the base branch head; it must be reachable from the base branch. The target must descend from the current baseline. A rejected fast-forward is followed by one re-read: if another writer moved the tag, the decision is re-evaluated once from the new commit; if the tag did not move, the error is terminal.

`--sweep` runs a sweep afterwards, also when nothing moved, so a re-dispatch is a safe retry. In a dry run the sweep is evaluated against the intended, unwritten tag positions.

Exit codes: `0`, `1` when the following sweep is incomplete, `2` error.

### `report`

Read-only. Prints the base head, the open PR count, and for every baseline its commit, whether that commit is on the base branch, and how many open PRs it binds. Stale versus current counts are added by the git adapter.

Exit codes: `0`, `2` when a baseline is not on the base branch (the report is still printed) or on an error.

## Baseline validation

All fatal before any request: valid JSON array with known fields only, at least one entry, tag names that pass `git check-ref-format`, unique tags, labels non-empty after trimming, `scope` and `markers` non-empty arrays of non-empty patterns. An entry without `label` and without `markers` moves only by `--force`. The default label applies only to the shorthand form.
