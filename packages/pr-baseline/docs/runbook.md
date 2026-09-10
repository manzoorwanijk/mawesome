# Runbook

## Rollout

1. **Create the label** each baseline uses (`Require PR update` by default) so maintainers can mark a PR whose merge should move the baseline.
2. **Run the refresh unseeded.** With no baseline ref, every open PR receives a pass. This proves the token, the creator and the permissions before anything can block.
3. **Seed the baseline** at the commit that every open PR must contain: `pr-baseline move-baseline --force --refresh-pr-statuses`, or `--to <sha>` for an older commit. The refresh stamps stale PRs with a failure.
4. **Let it converge.** A large repository may need more than one run because of the write budget; each run reports what is left. `pr-baseline report` shows the baseline and how many PRs it binds.
5. **Require the status context** in the base branch's ruleset with the source matching the token, as described in [permissions](./permissions.md).

## Everyday operations

- **Move on demand:** `pr-baseline move-baseline --force --refresh-pr-statuses` (a workflow dispatch with mode `move-baseline` in the action).
- **Retry an incomplete refresh:** run `refresh-pr-statuses` again, or dispatch the workflow. Every status already written is current and skipped, so retries are cheap.
- **Check what is stale:** `pr-baseline report`. With the git adapter it also counts stale and current PRs.
- **See the ref itself:** `git ls-remote origin 'refs/baselines/*'`. The refs have no page in the GitHub UI and no clone fetches them on its own.
- **Move one baseline of several:** `--baseline <name>`.

## Rollback

- **A baseline that left the base branch** (a force push or a hand-edited ref): every PR carries the misconfiguration pass and the sweep warns, so nothing is blocked and nothing is red; repair it with `pr-baseline move-baseline --force --refresh-pr-statuses`, or the dispatch with mode `move-baseline`.
- **A move that should not have happened:** delete the ref (`git push origin :refs/baselines/<name>`, or the refs API), then seed it again at the right commit with `--force --to <sha> --refresh-pr-statuses`. The tool never rewinds a baseline itself. Until the refresh runs, PRs keep the statuses from the wrong move.
- **Stop blocking without removing anything:** make the status context optional in the ruleset. Statuses keep being written and can be required again later.
- **Retire the tool:** remove the context from the ruleset, delete the workflow, delete the refs under `refs/baselines/`. Old statuses stay on their commits and stop mattering.

## What "Expected" means

A required status context that no run has written yet shows as "Expected" and blocks the PR. This happens when the context is required on a branch the tool does not serve, when the refresh never reached a PR, or when the `refresh-pr-status` job did not run for an event. Require the context only in the base branch's ruleset, and dispatch a refresh to stamp whatever is missing.

## Silent schedule loss

GitHub delays or drops scheduled runs under load and disables them in a public repository after 60 days without activity. If the last scheduled run in the Actions list is older than expected, dispatch the workflow by hand and, for a dormant repository, push any commit to re-enable the schedule.
