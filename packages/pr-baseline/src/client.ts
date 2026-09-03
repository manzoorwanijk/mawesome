import { runCheck } from './commands/check.ts';
import { runMoveBaseline } from './commands/move-baseline.ts';
import { runReport } from './commands/report.ts';
import { runSweep } from './commands/sweep.ts';
import type { ResolvedConfig } from './config.ts';
import { createRuntime } from './runtime.ts';
import type {
	CheckOptions,
	CheckResult,
	ClientOptions,
	MoveBaselineOptions,
	MoveBaselineResult,
	ReportResult,
	SweepResult,
} from './types.ts';

export interface Client {
	/** The fully resolved configuration, before the base branch and creator are read. */
	readonly config: ResolvedConfig;
	check(options?: CheckOptions): Promise<CheckResult>;
	sweep(): Promise<SweepResult>;
	moveBaseline(options?: MoveBaselineOptions): Promise<MoveBaselineResult>;
	report(): Promise<ReportResult>;
}

/** Creates a client bound to one repository and base branch; configuration errors throw here. */
export function createClient(options: ClientOptions = {}): Client {
	const runtime = createRuntime(options);
	return {
		config: runtime.config,
		check: (checkOptions = {}) => runCheck(runtime, checkOptions),
		sweep: () => runSweep(runtime),
		moveBaseline: (moveOptions = {}) => runMoveBaseline(runtime, moveOptions),
		report: () => runReport(runtime),
	};
}
