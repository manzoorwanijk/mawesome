import { runRefreshPrStatus } from './commands/refresh-pr-status.ts';
import { runMoveBaseline } from './commands/move-baseline.ts';
import { runReport } from './commands/report.ts';
import { runRefreshPrStatuses } from './commands/refresh-pr-statuses.ts';
import type { ResolvedConfig } from './config.ts';
import { createRuntime } from './runtime.ts';
import type {
	RefreshPrStatusOptions,
	RefreshPrStatusResult,
	ClientOptions,
	MoveBaselineOptions,
	MoveBaselineResult,
	ReportResult,
	RefreshPrStatusesResult,
} from './types.ts';

export interface Client {
	/** The fully resolved configuration, before the base branch and creator are read. */
	readonly config: ResolvedConfig;
	refreshPrStatus(options?: RefreshPrStatusOptions): Promise<RefreshPrStatusResult>;
	refreshPrStatuses(): Promise<RefreshPrStatusesResult>;
	moveBaseline(options?: MoveBaselineOptions): Promise<MoveBaselineResult>;
	report(): Promise<ReportResult>;
}

/** Creates a client bound to one repository and base branch; configuration errors throw here. */
export function createClient(options: ClientOptions = {}): Client {
	const runtime = createRuntime(options);
	return {
		config: runtime.config,
		refreshPrStatus: (refreshOptions = {}) => runRefreshPrStatus(runtime, refreshOptions),
		refreshPrStatuses: () => runRefreshPrStatuses(runtime),
		moveBaseline: (moveOptions = {}) => runMoveBaseline(runtime, moveOptions),
		report: () => runReport(runtime),
	};
}
