# Permissions

## What each command needs

| Command               | `contents` | `statuses`                         | `pull-requests` | Why                                                                          |
| --------------------- | ---------- | ---------------------------------- | --------------- | ---------------------------------------------------------------------------- |
| `refresh-pr-status`   | read       | write                              | read for `--pr` | Reads tags and compares commits; writes one status; reads the PR for `--pr`. |
| `refresh-pr-statuses` | read       | write                              | read            | Lists open PRs through GraphQL, compares commits, writes statuses.           |
| `move-baseline`       | **write**  | write with `--refresh-pr-statuses` | read            | Creates or fast-forwards the tag; lists merged PRs by label.                 |
| `report`              | read       | read                               | read            | Read-only; the PR listing includes each head's current status.               |

Everything else is denied. In a workflow, set `permissions: {}` at the top level and grant these per job.

## Per token type

| Token            | Creator               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`   | `github-actions[bot]` | The action proves the token is the workflow's own and resolves the creator without a request. The git adapter presents the same token to an https remote on every fetch, so a checkout with `persist-credentials: false` is enough. From the CLI, pass `--creator 'github-actions[bot]'`, because `GET /user` is not available to an installation token. Events it creates trigger no other workflows, so the refresh must run in the same job as the tag move. |
| Fine-grained PAT | the user's login      | Needs Contents read (write for `move-baseline`), Commit statuses write, Pull requests read on the repository. The creator is resolved through `GET /user`.                                                                                                                                                                                                                                                                                                      |
| GitHub App       | `<app-slug>[bot]`     | Same permissions as the PAT, granted to the installation. Pass `creator` explicitly; the tool refuses to guess, and a mismatch between the resolved creator and the login GitHub reports on a write fails the run.                                                                                                                                                                                                                                              |

## Ruleset setup

1. **Require the status context** (`PR baseline` by default) in the base branch's ruleset only. Requiring it on other branches shows "Expected" forever, because the tool writes nothing for PRs against them by default.
2. Set the ruleset's **status source** to match the token: "GitHub Actions" for `GITHUB_TOKEN`, the App for an App token, any source for a PAT. The refresh rewrites a status written by another creator, so the configured token always satisfies the pinned source.
3. **Protect the baseline tags** with a tag ruleset that restricts updates to whoever moves them: the GitHub Actions app for `GITHUB_TOKEN`, the App for an App token, the PAT's owning user for a PAT. A dedicated machine user is recommended where policy allows. The tool moves tags only by fast-forward, so a protected tag cannot be rewound by it.

Follow the [runbook](./runbook.md) for the order of operations: seed, let the refresh converge, verify with `report`, then require the context.
