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
describe('mirror workflow', () => {
	const text = read('mirror-action.yml');
	const resolve =
		/- name: Resolve the release\n[\s\S]*?run: \|\n([\s\S]*?)\n {6}-/.exec(text)?.[1] ?? '';

	it('runs from the changesets tag in its own serialized environment', () => {
		expect(text).toContain("tags: ['@mawesome/pr-baseline@*']");
		expect(text).toContain('environment: action-mirror');
		expect(text).toMatch(
			/concurrency:\n  group: mirror-action\n  cancel-in-progress: false\n  queue: max/,
		);
		expect(text).toContain('permission-contents: write');
		expect(text).toContain('repositories: ${{ env.MIRROR_REPO }}');
		expect(text).toContain('package-manager-cache: false');
	});

	it('validates the version, checks out the peeled tag commit, and requires it on main with a matching manifest', () => {
		expect(resolve).toContain("grep -Eq '^[0-9]+\\.[0-9]+\\.[0-9]+$'");
		expect(resolve).toContain('$tag^{}');
		expect(resolve).toContain('git merge-base --is-ancestor "$sha" FETCH_HEAD');
		expect(resolve).toContain('git checkout --quiet "$sha"');
		expect(resolve).toContain('test "$manifest" = "$version"');
	});

	it('stages, prepares, deploys, promotes and always cleans up with the same stage path', () => {
		expect(text.match(/--stage mirror-stage/g)).toHaveLength(2);
		expect(text).toContain("if: steps.prepare.outputs.deploy == 'true'");
		expect(text).toMatch(/always\(\) && steps\.prepare\.outcome != 'skipped'/);
		expect(text).toContain('rm -rf -- "__${MIRROR_REPO}__clone__"');
	});
});
