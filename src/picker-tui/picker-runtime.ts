/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * Mutable runtime state shared by the session-select screen's siblings
 * (run-session-select, picker-actions, picker-key-handler). Extracted from
 * session-select.ts so each sibling holds one purpose; the closures that
 * used to close over `let` bindings now read and write the fields on `rt`.
 */
import type {
	ArchivedSession,
	DaemonInfo,
	RestoreResult,
	SessionRowOp,
} from "./picker-rpc.ts";
import type { PickerConfig, SizingInfo } from "./types.ts";
import type { Row, SessionInfo } from "./row-build.ts";

// State + closure registry for one runSessionSelect() screen.
export interface PickerRuntime {
	// mutable state
	config: PickerConfig;
	baseConfig: PickerConfig;
	sessions: SessionInfo[];
	archived: ArchivedSession[];
	hidden: ArchivedSession[];
	daemonInfo: DaemonInfo;
	sizing: SizingInfo | null;
	selectedIdx: number;
	pendingDelete: { name: string; live: boolean } | null;
	pendingRestoreAck: (() => void) | null;
	statusMsg: string | null;
	loadError: string | null;
	retryTimer: ReturnType<typeof setTimeout> | null;
	activating: boolean;
	lastPaintCols: number;
	pendingEsc: boolean;
	escTimer: ReturnType<typeof setTimeout> | null;

	// I/O handles + tty state
	stdin: NodeJS.ReadStream;
	stdout: NodeJS.WriteStream;
	renderer: ReturnType<typeof import("./screen-renderer.ts").createScreenRenderer>;
	cleanupTerminal: () => void;
	quit: () => never;

	// core operations, wired by run-session-select.ts
	refreshData: () => Promise<void>;
	computeLayout: () => { rows: Row[]; leftIdx: number[]; rightIdx: number[]; emptyLeft: boolean };
	selectableIndices: (rows: Row[]) => number[];
	redraw: () => void;

	// actions, wired by picker-actions.ts
	attachTo: (name: string) => never;
	createSession: (name: string) => never;
	createDetached: (name: string) => void;
	moveSelection: (delta: number) => void;
	runMutation: (name: string, op: SessionRowOp, doneMsg: string) => void;
	armDelete: (name: string, live: boolean) => void;
	cancelDelete: () => void;
	rowAction: (key: "archive" | "unarchive" | "delete") => void;
	activate: () => Promise<void>;
	ackRestoreProblems: (name: string, outcome: RestoreResult) => Promise<void>;
}

// SessionInfo now lives in row-build.ts (the row model).

/** Build an initial rt with mutable defaults; closures filled in by run-session-select. */
export function createPickerRuntime(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, renderer: PickerRuntime["renderer"], config: PickerConfig): PickerRuntime {
	return {
		config,
		baseConfig: config,
		sessions: [],
		archived: [],
		hidden: [],
		daemonInfo: { version: "unknown", pid: 0, startedAt: "" },
		sizing: null,
		selectedIdx: 0,
		pendingDelete: null,
		pendingRestoreAck: null,
		statusMsg: null,
		loadError: null,
		retryTimer: null,
		activating: false,
		lastPaintCols: -1,
		pendingEsc: false,
		escTimer: null,

		stdin,
		stdout,
		renderer,
		cleanupTerminal: () => {},
		quit: () => process.exit(0) as never,

		refreshData: async () => {},
		computeLayout: () => ({ rows: [], leftIdx: [], rightIdx: [], emptyLeft: true }),
		selectableIndices: () => [],
		redraw: () => {},

		attachTo: ((_n: string) => process.exit(0)) as never,
		createSession: ((_n: string) => process.exit(0)) as never,
		createDetached: () => {},
		moveSelection: () => {},
		runMutation: () => {},
		armDelete: () => {},
		cancelDelete: () => {},
		rowAction: () => {},
		activate: async () => {},
		ackRestoreProblems: async () => {},
	};
}
