/**
 * CLI ↔ browser parity harness for the dependency-audit playground.
 *
 * Both paths share the analysis core (`auditPackage`); only the environment adapters differ —
 * the CLI fetches via pacote over the real filesystem, the browser fetches from a CDN into an
 * in-memory tree (see ../src/lib/dependency-audit/engine.ts). A divergence therefore means an
 * adapter fed the core a different tree (or resolved a different version), never that the
 * analysis disagrees. This harness runs a corpus through both and asserts they agree, so the
 * two stay locked together — it would have caught the `package/` tar-root and `pathe` bugs.
 *
 * Opt-in and network-bound: run it by hand (`node scripts/parity.ts`), never in `pnpm verify`.
 * Pass package specs as positional args to override the built-in corpus.
 */
import { parseArgs } from 'node:util';
import { audit } from '@mawesome/dependency-audit';
import type { AuditResult } from '@mawesome/dependency-audit';
import { runAudit } from '../src/lib/dependency-audit/engine.ts';

/**
 * A spread of cases the two paths historically diverged on or could:
 * `@types/*`-backed deps with odd DefinitelyTyped tar roots, scoped packages, `exports` maps,
 * CJS-only, ESM-only, dual packages, no-deps, and a scoped `@types` package audited directly.
 */
const CORPUS = [
	'@wordpress/components', // regression: @types/* tarballs root under `react v18.3/`, not `package/`
	'react', // @types-backed, exports map
	'react-dom',
	'lodash@4', // CJS, no deps
	'chalk@5', // ESM-only
	'debug@4', // @types/* dep pattern
	'zod', // ESM + ships its own types
	'picocolors', // tiny, no deps
	'@emotion/react', // scoped, complex exports
	'@types/node', // a scoped @types package audited directly
];

/**
 * A finding reduced to its substance, including the user-visible `suggestion` (deterministic).
 * Only `firstSeenIn` is excluded — it's a scan-order-dependent locator that would false-positive.
 */
function findingKey(f: AuditResult['findings'][number]): string {
	return `${f.surface}\t${f.kind}\t${f.specifier}\t${f.packageName}\t${f.suggestion}`;
}

/** The comparable projection of an audit result: version, findings, notices, unchecked, declared+resolved deps. */
interface Canonical {
	version: string | undefined;
	ok: boolean;
	findings: string[];
	notices: string[];
	unchecked: string[];
	deps: Record<string, string>;
}

function canonical(r: AuditResult): Canonical {
	const deps: Record<string, string> = {};
	// Keep both the declared range and the resolved version: a range mismatch is a real adapter
	// divergence even when today's resolved version happens to coincide.
	for (const d of r.resolvedDeps) deps[d.name] = `${d.range} → ${d.version}`;
	return {
		version: r.packageVersion,
		ok: r.ok,
		findings: r.findings.map(findingKey).toSorted(),
		notices: r.notices.map((n) => `${n.surface}\t${n.kind}\t${n.message}`).toSorted(),
		unchecked: r.unchecked.map((u) => `${u.specifier}\t${u.reason}`).toSorted(),
		deps,
	};
}

/** Lines describing every way `cli` and `browser` disagree (empty = parity). */
function diff(cli: Canonical, browser: Canonical): string[] {
	const out: string[] = [];
	if (cli.version !== browser.version)
		out.push(`version: cli=${cli.version} browser=${browser.version}`);
	if (cli.ok !== browser.ok) out.push(`ok: cli=${cli.ok} browser=${browser.ok}`);

	const setDiff = (label: string, a: string[], b: string[]): void => {
		const bs = new Set(b);
		const as = new Set(a);
		for (const x of a)
			if (!bs.has(x)) out.push(`${label} only in CLI:     ${x.replace(/\t/g, ' · ')}`);
		for (const x of b)
			if (!as.has(x)) out.push(`${label} only in browser: ${x.replace(/\t/g, ' · ')}`);
	};
	setDiff('finding', cli.findings, browser.findings);
	setDiff('notice', cli.notices, browser.notices);
	setDiff('unchecked', cli.unchecked, browser.unchecked);

	const names = new Set([...Object.keys(cli.deps), ...Object.keys(browser.deps)]);
	for (const name of [...names].toSorted()) {
		const a = cli.deps[name];
		const b = browser.deps[name];
		// A dep only one side declares means the manifests were read differently — a real divergence.
		if (!(name in cli.deps)) out.push(`dep ${name}: missing in CLI (browser=${b})`);
		else if (!(name in browser.deps)) out.push(`dep ${name}: missing in browser (cli=${a})`);
		else if (a !== b) out.push(`dep ${name}: cli=${a} browser=${b}`);
	}
	return out;
}

type Status = 'pass' | 'fail' | 'cap' | 'error';

interface Outcome {
	spec: string;
	status: Status;
	detail: string[];
}

/** A browser-only failure caused by the in-tab size guards is an expected environment limit, not a divergence. */
function isBrowserCap(error: unknown): boolean {
	return error instanceof Error && /too (large|many files)/.test(error.message);
}

async function check(spec: string): Promise<Outcome> {
	const [cliRes, browserRes] = await Promise.allSettled([audit(spec), runAudit(spec)]);

	/* A browser size-cap skip is only benign when the CLI itself succeeded; if both sides failed,
	 * fall through to error handling so a real CLI failure isn't masked as an expected cap. */
	if (
		cliRes.status === 'fulfilled' &&
		browserRes.status === 'rejected' &&
		isBrowserCap(browserRes.reason)
	) {
		return { spec, status: 'cap', detail: [String(browserRes.reason)] };
	}
	if (cliRes.status === 'rejected' || browserRes.status === 'rejected') {
		const detail: string[] = [];
		if (cliRes.status === 'rejected') detail.push(`CLI threw: ${cliRes.reason}`);
		if (browserRes.status === 'rejected') detail.push(`browser threw: ${browserRes.reason}`);
		return { spec, status: 'error', detail };
	}

	const detail = diff(canonical(cliRes.value), canonical(browserRes.value.result));
	return { spec, status: detail.length === 0 ? 'pass' : 'fail', detail };
}

const SYMBOL: Record<Status, string> = { pass: '✓', fail: '✗', cap: '∅', error: '!' };

async function main(): Promise<void> {
	const { positionals } = parseArgs({ allowPositionals: true });
	const specs = positionals.length > 0 ? positionals : CORPUS;

	console.error(`Checking ${specs.length} package(s) — CLI vs browser…\n`);
	const outcomes: Outcome[] = [];
	for (const spec of specs) {
		// Sequential to keep load on npm/jsDelivr polite; the two paths per spec already run in parallel.
		// eslint-disable-next-line no-await-in-loop -- intentional throttle on a network-bound corpus
		const outcome = await check(spec);
		outcomes.push(outcome);
		console.error(`${SYMBOL[outcome.status]} ${spec}`);
		for (const line of outcome.detail) console.error(`    ${line}`);
	}

	const counts = outcomes.reduce<Record<Status, number>>(
		(acc, o) => ({ ...acc, [o.status]: acc[o.status] + 1 }),
		{ pass: 0, fail: 0, cap: 0, error: 0 },
	);
	console.error(
		`\n${counts.pass} parity · ${counts.fail} diverged · ${counts.cap} browser-cap · ${counts.error} errored`,
	);
	// Diverged or errored is a real problem; a browser size-cap skip is expected and stays green.
	if (counts.fail > 0 || counts.error > 0) process.exitCode = 1;
}

if (import.meta.main) {
	await main();
}
