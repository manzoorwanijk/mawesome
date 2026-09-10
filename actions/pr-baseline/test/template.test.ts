import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const template = readFileSync(join(import.meta.dirname, '..', 'workflow-template.yml'), 'utf8');

/** The `pull_request_target` trigger is safe only while the refresh-pr-status job never checks out or runs PR code. */
describe('consumer workflow template', () => {
	const [, status = '', refresh = ''] =
		/^jobs:\n  refresh-pr-status:\n([\s\S]*?)\n  refresh-pr-statuses:\n([\s\S]*)$/m.exec(
			template,
		) ?? [];

	it('keeps the refresh-pr-status job free of checkouts and shell steps', () => {
		expect(status.length).toBeGreaterThan(0);
		expect(status).not.toContain('actions/checkout');
		expect(status).not.toMatch(/^\s+run:/m);
		expect(status).toContain('statuses: write');
		expect(status).not.toContain('pull-requests');
	});

	it('gives the refresh job a treeless full-history checkout without credentials', () => {
		expect(refresh).toContain('fetch-depth: 0');
		expect(refresh).toContain('filter: tree:0');
		expect(refresh).toContain('persist-credentials: false');
		expect(refresh).toContain('queue: max');
	});

	it('defines the baseline list once and reads it in both jobs', () => {
		const env = /^  PR_BASELINES: '(.*)'$/m.exec(template)?.[1] ?? '';
		expect(Array.isArray(JSON.parse(env))).toBe(true);
		// Comment lines excluded: the commented-out backfill job reads it too.
		const active = template
			.split('\n')
			.filter((line) => !line.trimStart().startsWith('#'))
			.join('\n');
		expect(active.match(/baselines: \$\{\{ env\.PR_BASELINES \}\}/g)).toHaveLength(2);
	});

	it('runs once per merge and keeps the counts in the log rather than an artifact', () => {
		// A merge fires `push` too, so a `closed` trigger would only queue the same job a second time.
		expect(template).toContain('types: [opened, synchronize, reopened, ready_for_review, edited]');
		expect(refresh).not.toContain("github.event.action == 'closed'");
		// The results file is still an output for a workflow that wants it.
		expect(template).not.toContain('upload-artifact');
	});

	it('offers the backfill as a commented-out job, with the scope wired through', () => {
		expect(template).toContain('#          scope: unstamped');
		expect(template).toContain("scope: ${{ inputs.scope || '' }}");
	});
});
