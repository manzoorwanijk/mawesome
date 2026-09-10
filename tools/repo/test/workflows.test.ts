import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflows = join(import.meta.dirname, '..', '..', '..', '.github', 'workflows');
const read = (name: string): string => readFileSync(join(workflows, name), 'utf8');

/** The dogfood workflow runs with write permissions under pull_request_target and merge_group, so it may only ever run main. */
describe('pr-baseline dogfood workflow', () => {
	const text = read('pr-baseline.yml');
	const jobs = text
		.slice(text.indexOf('\njobs:\n'))
		.split(/^  (?=[\w-]+:\n)/m)
		.slice(1);

	it('checks out main explicitly in every job', () => {
		expect(jobs.length).toBeGreaterThanOrEqual(2);
		for (const job of jobs) {
			const checkouts =
				job.match(/uses: actions\/checkout@[\s\S]*?with:\n([\s\S]*?)\n {6}-/g) ?? [];
			expect(checkouts.length).toBeGreaterThan(0);
			for (const checkout of checkouts) {
				expect(checkout).toContain('ref: main');
				expect(checkout).toContain('persist-credentials: false');
			}
		}
	});

	it('never checks out the pull request head', () => {
		expect(text).not.toMatch(/github\.event\.pull_request\.head/);
		expect(text).not.toMatch(/refs\/pull\//);
	});
});

/** The mirror workflow runs the tagged commit with the release App's token, so what it trusts must stay pinned down. */
describe('deploy-to-mirror workflow', () => {
	const text = read('deploy-to-mirror.yml');
	const resolve =
		/- name: Resolve the release\n[\s\S]*?run: \|\n([\s\S]*?)\n {6}-/.exec(text)?.[1] ?? '';

	it('runs from any action changesets tag in its own serialized environment', () => {
		expect(text).toContain("tags: ['@mawesome/*-action@*']");
		expect(text).toContain('environment: action-mirror');
		expect(text).toMatch(
			/concurrency:\n  group: deploy-to-mirror\n  cancel-in-progress: false\n  queue: max/,
		);
		expect(text).toContain('permission-contents: write');
		expect(text).toContain('repositories: ${{ steps.action.outputs.mirror_repo }}');
		expect(text).toContain('package-manager-cache: false');
	});

	it('validates the package and version, checks out the peeled tag commit, and requires it on main', () => {
		expect(resolve).toContain("grep -Eq '^@mawesome/[a-z0-9-]+-action$'");
		expect(resolve).toContain("grep -Eq '^[0-9]+\\.[0-9]+\\.[0-9]+$'");
		expect(resolve).toContain('$tag^{}');
		expect(resolve).toContain('origin "$sha" \'+refs/heads/main:refs/remotes/origin/main\'');
		expect(resolve).toContain('git merge-base --is-ancestor "$sha" refs/remotes/origin/main');
		expect(resolve).not.toContain('FETCH_HEAD');
		expect(text).toMatch(
			/- name: Checkout\n\s+uses: actions\/checkout@\w+ # v[\d.]+\n\s+with:\n\s+fetch-depth: 0\n\s+filter: tree:0/,
		);
		expect(resolve).toContain('git checkout --quiet "$sha"');
	});

	/* The mirror repository and the files that reach it come from the workspace manifest, so a second action brings its own. */
	it('takes the mirror and the staged files from the action workspace', () => {
		expect(text).toContain(
			'run: node tools/repo/scripts/deploy-to-mirror.ts resolve --package "$PACKAGE" --version "$VERSION"',
		);
		expect(text).toMatch(/deploy-to-mirror\.ts stage\n\s+--package "\$PACKAGE"/);
		expect(text).toContain('pnpm --filter "$PACKAGE..." build');
		expect(text).not.toContain('ACTION_DIR');
	});

	/* Nothing but this workflow writes the mirror's refs: it commits in a checkout of its own and pushes once. */
	it('commits in an official checkout of the mirror instead of delegating to another action', () => {
		expect(text).toMatch(
			/- name: Check out the mirror\n\s+uses: actions\/checkout@\w+ # v[\d.]+\n\s+with:\n\s+repository: \$\{\{ steps\.action\.outputs\.mirror \}\}\n\s+token: \$\{\{ steps\.mirror-token\.outputs\.token \}\}\n\s+persist-credentials: true[^\n]*\n\s+path: mirror\n\s+fetch-depth: 0/,
		);
		expect(text).toMatch(/deploy-to-mirror\.ts publish\n\s+--repo mirror\n\s+--stage mirror-stage/);
		expect(text).not.toContain('action-deploy-to-repo');
	});

	it('commits as the App bot and announces the release on the mirror', () => {
		expect(text).toContain('GIT_AUTHOR_NAME: ${{ steps.bot.outputs.name }}');
		expect(text).toContain('GIT_COMMITTER_EMAIL: ${{ steps.bot.outputs.email }}');
		expect(text).toContain('gh release view "v$VERSION" --repo "$MIRROR"');
		expect(text).toContain('gh release create "v$VERSION" --repo "$MIRROR"');
	});
});
