# PR Baseline action

> Keep open pull requests current with a movable baseline on the base branch, reported through commit statuses.

**This repository is generated.** It mirrors the `action/` directory of [`@mawesome/pr-baseline`](https://github.com/mawesomedev/mawesome/tree/main/packages/pr-baseline) with the bundled `dist/` and a `release.json` naming the release added; open issues and pull requests there. Full documentation lives in the package's [docs](https://github.com/mawesomedev/mawesome/tree/main/packages/pr-baseline/docs).

A repository-wide change lands on the base branch and every open PR branched before it keeps passing CI on stale code. This action marks that commit with a git ref under `refs/baselines/`, the **baseline**, and stamps every open PR with a commit status: `success` when the PR's head contains the baseline, `failure` when it does not. Require the status in the base branch's ruleset and stale PRs must merge or rebase before they can land. The baseline moves forward only by intent: a workflow dispatch, a merged PR carrying a label, or a push touching marker paths.

## Usage

One workflow, two jobs, both calling this action. Copy it, replace every `BASE` with your base branch, pin the action and `actions/checkout` to commit SHAs, and adjust `PR_BASELINES`.

<!-- workflow:start -->

```yaml
name: PR baseline
# Replace every BASE below with your base branch (for example main). The env context is unavailable
# in a job-level `if`, so the branch name is a literal in the marked places.
on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review, edited, closed]
  merge_group:
  push:
    branches: [BASE]
  schedule:
    - cron: '17 * * * *'
  workflow_dispatch:
    inputs:
      mode:
        type: choice
        default: auto
        options: [auto, move-baseline, refresh-pr-statuses]
        description: auto recovers like the schedule; move-baseline forces a move and then refreshes; refresh-pr-statuses only refreshes open PR statuses
      baseline:
        type: string
        default: ''
        description: Name of one baseline to move; blank moves all
permissions: {}
env:
  # One source of truth for both jobs. Omit to use the single default baseline.
  PR_BASELINES: '[{"name":"pr-baseline","label":"Require PR update","markers":[".nvmrc"]}]'
jobs:
  refresh-pr-status:
    name: Refresh the PR status against the baseline
    if: >-
      !github.event.repository.fork &&
      (github.event_name == 'merge_group' || (github.event_name == 'pull_request_target' && github.event.action != 'closed'))
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      statuses: write
    concurrency:
      group: pr-baseline-status-${{ github.event.pull_request.number || github.event.merge_group.head_sha }}
      cancel-in-progress: false
    steps:
      - uses: mawesomedev/pr-baseline-action@<sha> # vX.Y.Z
        with:
          base: BASE
          baselines: ${{ env.PR_BASELINES }}
  refresh-pr-statuses:
    name: Move baselines and refresh PR statuses
    if: >-
      !github.event.repository.fork && (
        (github.event_name == 'pull_request_target' && github.event.action == 'closed' && github.event.pull_request.merged) ||
        (github.event_name == 'push' && github.ref_name == 'BASE') ||
        github.event_name == 'schedule' ||
        github.event_name == 'workflow_dispatch'
      )
    runs-on: ubuntu-latest
    timeout-minutes: 60
    permissions:
      contents: write
      statuses: write
      pull-requests: read
    concurrency:
      group: pr-baseline-refresh
      cancel-in-progress: false
      queue: max # Delete this line on GitHub Enterprise Server; one pending run is enough there.
    steps:
      - uses: actions/checkout@<sha> # vN
        with:
          ref: BASE
          fetch-depth: 0
          filter: tree:0
          persist-credentials: false
      - id: pr-baseline
        uses: mawesomedev/pr-baseline-action@<sha> # vX.Y.Z
        with:
          base: BASE
          baselines: ${{ env.PR_BASELINES }}
          mode: ${{ inputs.mode || 'auto' }}
          force: ${{ inputs.mode == 'move-baseline' }}
          baseline: ${{ inputs.baseline || '' }}
      - if: ${{ always() && steps.pr-baseline.outputs.results-file != '' }}
        uses: actions/upload-artifact@<sha> # vN
        with:
          name: pr-baseline-refresh
          path: ${{ steps.pr-baseline.outputs.results-file }}
```

<!-- workflow:end -->

The `refresh-pr-status` job never checks out code: the head SHA comes from the event. The `refresh-pr-statuses` job's treeless, full-history checkout gives the action the commit graph without trees or blobs, and the action fetches what else it needs itself, authenticated with the same token.

## Modes

`mode: auto` (the default) maps the event to a command:

| Event                                           | What runs                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `pull_request_target`, any type but `closed`    | `refresh-pr-status` on the PR head, status written. The supported path for fork PRs.                                            |
| any event, run triggered by Dependabot          | The workflow token is read-only: a PR is evaluated without writing, a move or refresh is skipped; the schedule recovers.        |
| `pull_request_target` type `closed` and merged  | `move-baseline` (a labeled merge moves its baseline) followed by a refresh.                                                     |
| `pull_request_target` type `closed`, not merged | Nothing, with a notice.                                                                                                         |
| `pull_request`                                  | `refresh-pr-status`; with the workflow token the status is written only for a same-repository PR not triggered by Dependabot.   |
| `merge_group`                                   | `refresh-pr-status` on the merge group's head when its base is the configured branch; otherwise the `other-bases` rule applies. |
| `push` to the base branch                       | `move-baseline` (path markers, merges made without a PR event) followed by a refresh.                                           |
| `schedule`                                      | Non-forced `move-baseline` followed by a refresh, so a missed move is recovered and stale PRs converge.                         |
| `workflow_dispatch`                             | The same as `schedule`; the template's `mode` input passes `move-baseline` with `force` or `refresh-pr-statuses` explicitly.    |

Explicit modes (`refresh-pr-status`, `refresh-pr-statuses`, `move-baseline`, `report`) take the inputs as given; `refresh-pr-status` then needs `sha`.

## Inputs

<!-- inputs:start -->

| Input                            | Description                                                                                                      | Default               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------- |
| `token`                          | Token used for every read and write; defaults to the workflow's own token.                                       | `${{ github.token }}` |
| `mode`                           | What to do: auto (from the event), refresh-pr-status, refresh-pr-statuses, move-baseline or report.              | `auto`                |
| `sha`                            | Commit to evaluate in refresh-pr-status mode; auto takes it from the event.                                      |                       |
| `base`                           | Base branch; defaults to the repository's default branch.                                                        |                       |
| `baselines`                      | JSON array of `{ name, label?, scope?, markers? }`, inline only; cannot be combined with name, label or markers. |                       |
| `name`                           | Shorthand for a single baseline's name (default `pr-baseline`).                                                  |                       |
| `label`                          | Shorthand for a single baseline's label (default `Require PR update`).                                           |                       |
| `markers`                        | Shorthand for a single baseline's auto-move patterns, one gitignore pattern per line.                            |                       |
| `baseline`                       | In move-baseline mode, move only the baseline with this name; blank moves all.                                   |                       |
| `status-context`                 | Status context (default `PR baseline`).                                                                          |                       |
| `description-pass`               | Description of a passing status; `{base}` and `{baselines}` are replaced.                                        |                       |
| `description-fail`               | Description of a failing status; `{base}` and `{baselines}` are replaced.                                        |                       |
| `description-not-applicable`     | Description written for PRs against other branches when other-bases is pass.                                     |                       |
| `target-url`                     | Link attached to every status; by default a failing status links to the compare view of what it lacks.           |                       |
| `other-bases`                    | PRs against other branches: skip (default) or pass.                                                              |                       |
| `creator`                        | Login the token writes statuses as; required for a GitHub App token.                                             |                       |
| `ancestry`                       | Ancestry source: auto (default), git or api.                                                                     |                       |
| `max-writes-per-run`             | Stop a refresh after this many status writes; a positive integer (default 450).                                  |                       |
| `max-writes-per-minute`          | Pace status writes; a positive integer per minute (default 60).                                                  |                       |
| `dry-run`                        | Log every intended write and baseline move instead of making it.                                                 | `false`               |
| `force`                          | In move-baseline mode, move by intent alone and seed absent baselines.                                           | `false`               |
| `refresh-pr-statuses-after-move` | In move-baseline mode, refresh every open PR's status afterwards (default true).                                 | `true`                |

<!-- inputs:end -->

`token` defaults to the workflow's own token. With a GitHub App token, pass `creator` (the App's `<slug>[bot]` login); with a personal access token the creator is resolved from the token.

## Outputs

<!-- outputs:start -->

| Output         | Description                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `state`        | Status state of the checked commit (`success` or `failure`), or of the run (`success`, `failure`, `skipped` or `error`). |
| `description`  | Status description of the checked commit.                                                                                |
| `base`         | The base branch the run served.                                                                                          |
| `baselines`    | JSON array of `{ name, sha }` for every configured baseline.                                                             |
| `missing`      | JSON array of baseline names the evaluated commit lacks (refresh-pr-status mode).                                        |
| `written`      | Statuses written.                                                                                                        |
| `skipped`      | PRs whose status was already current.                                                                                    |
| `closed`       | PRs that closed while the refresh ran.                                                                                   |
| `deferred`     | PRs whose head was still moving.                                                                                         |
| `failed`       | PRs whose status could not be written.                                                                                   |
| `incomplete`   | Whether a refresh stopped before covering every PR (`true` or `false`).                                                  |
| `summary`      | JSON summary of the run, per-PR results capped to stay under the output size limit.                                      |
| `results-file` | Path of a JSON file with the uncapped per-PR results of a refresh, for an upload step.                                   |

<!-- outputs:end -->

Every run, including a skip or an error, sets every output and writes a step summary. `summary` is a JSON string a following step can turn into a comment or a check run; `results-file` holds the uncapped per-PR results of a refresh for an artifact upload.

## Permissions

| Job                   | `contents` | `statuses` | `pull-requests` |
| --------------------- | ---------- | ---------- | --------------- |
| `refresh-pr-status`   | read       | write      |                 |
| `refresh-pr-statuses` | write      | write      | read            |

Require the status context (`PR baseline` by default) in the base branch's ruleset only, with the source matching the token. The baseline refs live under `refs/baselines/`, which no clone fetches and no ruleset covers: whoever has `contents: write` can move them, and the tool only ever fast-forwards them. The package docs cover [permissions](https://github.com/mawesomedev/mawesome/blob/main/packages/pr-baseline/docs/permissions.md), [rate limits](https://github.com/mawesomedev/mawesome/blob/main/packages/pr-baseline/docs/rate-limits.md), [edge cases](https://github.com/mawesomedev/mawesome/blob/main/packages/pr-baseline/docs/edge-cases.md) and the [runbook](https://github.com/mawesomedev/mawesome/blob/main/packages/pr-baseline/docs/runbook.md).

## Support

GitHub.com is the primary target. GitHub Enterprise Server works through the runner's `GITHUB_API_URL`, `GITHUB_GRAPHQL_URL` and `GITHUB_SERVER_URL`; the action is reachable through GitHub Connect or a local mirror. The action runs on the `node24` runtime and needs git 2.45 or newer on the runner for git ancestry.

## License

[MIT](./LICENSE)
