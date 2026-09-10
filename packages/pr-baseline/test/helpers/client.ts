import {
	createClient,
	type Client,
	type ClientOptions,
	type RefreshScope,
} from '../../src/index.ts';
import { FakeGitHub, sha } from '@mawesome/testing/github';

export interface Harness {
	github: FakeGitHub;
	client: Client;
	logs: string[];
	warnings: string[];
	sleeps: number[];
	clock: { now: number };
}

/**
 * A client wired to the fake GitHub with a fake clock and sleep.
 * The default repository has `main` at commit 5 on a linear history 1..5.
 */
export function harness(
	/* This suite predates scoping and asserts the full sweep, so `scope` defaults to `all` here;
	 * a case that wants the library's own default passes `scope: undefined`. */
	options: Omit<ClientOptions, 'scope'> & { scope?: RefreshScope | undefined } = {},
	setup?: (github: FakeGitHub) => void,
): Harness {
	const { scope: requested, ...rest } = options;
	const scope = 'scope' in options ? requested : 'all';
	const github = new FakeGitHub();
	github.chain(1, 5);
	github.branch('main', sha(5));
	setup?.(github);
	const logs: string[] = [];
	const warnings: string[] = [];
	const sleeps: number[] = [];
	const clock = { now: 1_000_000 };
	const client = createClient({
		repo: github.repo,
		token: 'test-token',
		// Delegated per call so a test can wrap `github.fetch` after construction.
		fetch: (input, init) => github.fetch(input, init),
		logger: { info: (message) => logs.push(message), warn: (message) => warnings.push(message) },
		sleep: (ms) => {
			sleeps.push(ms);
			clock.now += ms;
			return Promise.resolve();
		},
		now: () => clock.now,
		retryBaseMs: 0,
		tokenIsWorkflowToken: true,
		// No clone and no git here: the fake API is the whole world, refs included.
		ancestry: 'api',
		env: {},
		...rest,
		...(scope === undefined ? {} : { scope }),
	});
	return { github, client, logs, warnings, sleeps, clock };
}

export { sha };
