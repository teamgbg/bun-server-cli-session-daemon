/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Getting a lane's opening brief into the pane that was just spawned for it.
 *
 * Split out of spawn-core.ts, which had grown past the 1000-line budget. The
 * unit is cohesive rather than merely extractable: every symbol here answers one
 * question — is this freshly-created pane ready to accept input, and did the
 * brief actually reach it AND start a turn. option-spawn owns creating the window
 * and recording the tab; delivery is a separate concern with its own failure
 * modes, and both of those failure modes were silent before they were named here.
 */

/**
 * Wait until the pane's CLI is ready to accept input.
 *
 * A FIXED delay is wrong twice over. It is a guess about someone else's startup
 * — 6s was shorter than a Claude Code CLI takes to reach its prompt, so the keys
 * landed in a booting TUI and were silently dropped while the spawn still
 * reported ok:true (observed 2026-07-27, the pane started and nothing happened).
 * And it is the busy-wait shape doctrine forbids: waiting a duration rather than
 * reacting to the condition.
 *
 * Readiness is read from the pane's own rendered content — a CLI that has
 * painted its prompt is a CLI that will accept keys. The ceiling is bounded so a
 * CLI that never starts fails the delivery instead of hanging the spawn, and the
 * caller degrades that to a warning.
 */

		// ASYNC capture, not spawnSync. The loop yields between iterations, but a
		// SYNCHRONOUS subprocess blocks the daemon's single event loop for the
		// whole tmux round-trip on EVERY iteration — and this loop runs for as
		// long as a CLI takes to paint a stable prompt, per concurrent spawn.
		//
		// The symptom is not a slow spawn, it is a dead daemon: /rpc/spawn stopped
		// responding entirely while /rpc/options and /rpc/resolve-session kept
		// answering in 0ms, because those are served between blocks. `ss` showed a
		// 29-deep accept backlog on the picker port, and three consecutive fleet
		// spawns timed out with nothing ever reaching the handler's own logging.
		// Restarting cleared it for under a minute (2026-07-30).

/**
 * Whether tmux still knows about a pane.
 *
 * Used to separate "this pane has not painted yet" from "this pane is gone",
 * which `capture-pane` alone cannot express — a distinction that decides whether
 * a spawn is slow or failed.
 *
 * Membership in `list-panes -a`, NOT a `-t <pane>` lookup: a targeted tmux
 * command run from inside tmux resolves an unknown target against the CALLER's
 * own pane, so `display-message -t <dead pane>` succeeds and reports the pane
 * asking the question. That false "alive" is indistinguishable from a real one
 * and put the fast path back to sleep for the full ceiling. Enumerating is
 * unambiguous and equally cheap.
 */

/**
 * Type a lane's opening instruction into its freshly spawned pane.
 *
 * This is the picker writing into a pane IT just created, which is the one place
 * `tmux send-keys` is correct: the picker owns tmux, the pane has no other
 * occupant, and there is no channel subscriber to route through yet. It is NOT
 * the prohibited case — `orchestrator-terminal-is-trusted-input` forbids writing
 * into the OPERATOR's terminal, and lane-to-lane traffic still goes over the
 * channel.
 *
 * Delivery is verified in THREE stages, each of which the prior code either
 * skipped or verified with a proxy that a stalled lane satisfies:
 *  1. PASTE the brief, then confirm the composer now HOLDS it. This is the
 *     precondition the positional-arg path lacked — that path sent Enter to a
 *     composer that was empty from the start (the positional was stranded, never
 *     typed in), so the Enter was a no-op and a later "composer is empty" check
 *     read a state that was never filled as "submitted" (2026-07-31). Requiring
 *     the composer to hold the brief makes an empty-composer submit structurally
 *     impossible; a paste the TUI dropped (while it is still indexing the
 *     workspace) is re-pasted, never silently submitted as nothing.
 *  2. SEND Enter and confirm the composer EMPTIED — the TUI consumed the input.
 *  3. VERIFY A PRODUCED TURN — the ONLY admissible evidence the brief reached
 *     the model, never an emptied composer. An emptied composer proves the TUI
 *     consumed the input; it does not prove the model began a turn. The prior
 *     verification stopped at the emptied composer and so reported dispatch
 *     successful while lanes sat on unread briefs doing nothing (2026-07-31 —
 *     three lanes at 4% context with zero uploads, each reported delivered).
 *     A produced turn is read through `paneProducedTurn` (pane-inventory): for
 *     one TUI the cumulative upload counter is empty until the first turn and
 *     gains a figure it keeps, so empty→non-empty is the proof; other CLIs
 *     delegate to their busy classifier.
 *
 * `cliKind` selects the produced-turn signal per CLI; it is derived from the
 * option's cli_id-derived family key by the caller (option-spawn), the same key
 * the busy detector classifies on.
 */

	// PASTE the brief into the composer (one operation, not a keystroke stream —
	// `set-buffer` + `paste-buffer` is tmux's own paste mechanism, which is what a
	// TUI's paste handling expects, instead of being retyped into it character by
	// character). The buffer is named per-pane so two concurrent spawns cannot
	// claim each other's text, and `-d` deletes it after pasting so a brief cannot
	// leak into a later paste.
	// PASTE the brief, then VERIFY it landed in the composer before submitting
	// — the precondition the positional-arg path lacked (it sent Enter to a
	// composer empty from the start, so the Enter no-oped while a later
	// "composer is empty" check read a never-filled state as "submitted",
	// 2026-07-31). A TUI still booting (some CLIs index the workspace on
	// startup) can drop a paste delivered too early; the held check catches
	// that and the loop re-pastes within the deadline rather than submitting
	// nothing.

/**
 * Read the composer by way of the CURSOR LINE, and only that line.
 *
 * The brief stays visible in the transcript after it is submitted, so "is the
 * text on screen" cannot separate a submitted prompt from a stuck one. What
 * separates them is where the cursor rests: an unsubmitted brief ends at the
 * cursor, and a submitted one leaves the cursor on an empty input.
 *
 * Neighbouring lines are deliberately not consulted. A CLI that renders the
 * message it just accepted directly above its composer would put that text one
 * row from the cursor, and any lookback would then read a successful delivery
 * as a failure — re-sending a brief the lane already has.
 */

/**
 * The ONE ceiling on a whole delivery, clamping every stage deadline below it.
 *
 * Chosen to stay comfortably inside a gateway tool call's lifetime, because the
 * failure this closes is not slowness — it is a caller that gets NO ANSWER. When
 * the stages compounded past the caller's timeout, `spawn_agent_tab` returned
 * neither ok:true nor ok:false, so the orchestrator could not tell a created
 * lane from a failed one and had no state to act on. Bounding the total is what
 * makes the tool's return value exist at all, and a return value that always
 * exists is the precondition for it being honest.
 */

import { spawn, spawnSync } from "@teamscala/os/spawn/spawn";
import { createLogger } from "@teamscala/logger/creator";
import type { CliKind } from "@teamscala/pane-inventory/agent-pane-detect";
import { paneProducedTurn } from "@teamscala/pane-inventory/busy-detect";

const logger = createLogger({ service: "cli-session" });

/** Why a prompt-ready wait ended — a dead pane is not a slow one. */
export type PromptReadyOutcome = "ready" | "vanished" | "timeout";
/** Why an opening brief did or did not reach its lane. */
export type DeliveryOutcome = "delivered" | "undelivered" | "vanished";

const PROMPT_READY_TIMEOUT_MS = 60_000;
const PROMPT_STABLE_MS = 1_500;
/** Gap between pane captures while waiting for a CLI to paint its prompt. */
const PROMPT_POLL_INTERVAL_MS = 500;

export async function waitForPromptReady(
	paneId: string,
	budgetDeadline?: number,
): Promise<PromptReadyOutcome> {
	// The caller's OVERALL budget caps this wait. Without it each of the three
	// delivery stages carried its own independent ceiling and they COMPOUNDED —
	// 60s ready + 90s paste + a 90s submit loop that re-entered this 60s wait on
	// every iteration + 30s turn-verify, worst case well past four minutes. The
	// gateway call times out long before that, so the caller learned NOTHING
	// while the daemon kept working (measured 2026-08-01: two spawn_agent_tab
	// calls returned no result at all, and one left a stranded pane holding an
	// unsubmitted brief). A stage ceiling is a per-stage sanity bound; the budget
	// is what keeps the whole operation answerable within a caller's lifetime.
	const deadline = Math.min(
		Date.now() + PROMPT_READY_TIMEOUT_MS,
		budgetDeadline ?? Number.POSITIVE_INFINITY,
	);
	let lastPaint = "";
	let stableSince = 0;
	// Yields FIRST, then samples. Awaiting at the top rather than the bottom is not
	// cosmetic: a CLI has painted nothing in the instant after its window is created,
	// so the first capture is guaranteed useless, and sampling before yielding holds
	// the daemon event loop through a pointless tmux round-trip before it ever gives
	// way. Reconcile, picker-data and every other spawn share that same loop.
	while (Date.now() < deadline) {
		await Bun.sleep(PROMPT_POLL_INTERVAL_MS);
		const cap = await spawn({
			name: "tmux:capture-pane",
			command: ["tmux", "capture-pane", "-p", "-t", paneId],
			timeoutMs: 5_000,
		});
		// tmux captures a LIVE pane that has painted nothing as exit 0 with empty
		// output, so a NON-ZERO exit does not mean "not ready yet" — it means tmux
		// cannot find the pane. For a pane THIS function was handed moments ago,
		// that means its command already exited and the window closed: the lane is
		// dead. Treating that as "still painting" is what made a failed spawn cost
		// the full 60s ceiling and then report ok:true for a window that does not
		// exist (observed 2026-07-30: POST /rpc/spawn 200 62166ms, no window). A
		// second existence probe keeps a transient tmux hiccup from being read as a
		// dead lane, so the fast path stays correct rather than merely fast.
		if ((cap.exitCode ?? 1) !== 0) {
			if (!(await paneExists(paneId))) return "vanished";
			continue;
		}
		const painted = cap.stdout.toString().trimEnd();
		if (painted.length > 0) {
			// A CLI repaints continuously while booting. Two identical captures a
			// beat apart mean it has settled on a prompt rather than mid-render,
			// which is the closest observable proxy for "accepting input" that does
			// not require knowing each CLI's banner.
			if (painted === lastPaint) {
				if (stableSince === 0) stableSince = Date.now();
				if (Date.now() - stableSince >= PROMPT_STABLE_MS) return "ready";
			} else {
				stableSince = 0;
				lastPaint = painted;
			}
		}
		// Await a real sleep rather than blocking on a `sleep` subprocess. A sync
		// spin here holds the daemon event loop for the whole poll window, so every
		// other RPC — reconcile, picker-data, another spawn — waits behind one pane
		// painting its prompt (react-dont-busy-wait; no-bespoke-process-locking).
		await Bun.sleep(500);
	}
	return "timeout";
}

async function paneExists(paneId: string): Promise<boolean> {
	const probe = await spawn({
		name: "tmux:list-panes",
		command: ["tmux", "list-panes", "-a", "-F", "#{pane_id}"],
		timeoutMs: 5_000,
	});
	if ((probe.exitCode ?? 1) !== 0) return false;
	return probe.stdout.toString().split("\n").includes(paneId);
}

export async function deliverInitialPrompt(
	paneId: string,
	prompt: string,
	cliKind: CliKind,
): Promise<DeliveryOutcome> {
	const oneLine = prompt.replace(/[\r\n]+/g, " ").trim();
	if (!oneLine) return "undelivered";
	// ONE budget for the whole delivery. Every stage deadline below is clamped to
	// it, so the total is bounded by construction rather than by three ceilings
	// that happen to add up to something a caller can wait for.
	const budgetDeadline = Date.now() + DELIVERY_BUDGET_MS;
	const send = (args: string[]) =>
		spawnSync({ name: "tmux:initial-prompt", command: ["tmux", ...args], timeoutMs: 5_000 });
	const ready = await waitForPromptReady(paneId, budgetDeadline);
	if (ready !== "ready") return ready === "vanished" ? "vanished" : "undelivered";

	const buffer = `scala-brief-${paneId.replace(/[^A-Za-z0-9]/g, "")}`;
	// Stage the buffer ONCE (without -d, so it survives a re-paste); deleted after.
	const staged = send(["set-buffer", "-b", buffer, "--", oneLine]);
	if ((staged.exitCode ?? 1) !== 0) return "undelivered";
	const pasteDeadline = Math.min(Date.now() + SUBMIT_DEADLINE_MS, budgetDeadline);
	let holding = false;
	while (Date.now() < pasteDeadline) {
		const pasted = send(["paste-buffer", "-b", buffer, "-t", paneId]);
		if ((pasted.exitCode ?? 1) !== 0) {
			send(["delete-buffer", "-b", buffer]);
			return "undelivered";
		}
		// LET THE PASTE SETTLE before reading the composer.
		await Bun.sleep(SUBMIT_SETTLE_MS);
		const state = composerState(paneId);
		if (state === "gone") {
			send(["delete-buffer", "-b", buffer]);
			return "vanished";
		}
		if (state === "holding") {
			holding = true;
			break;
		}
	}
	send(["delete-buffer", "-b", buffer]);
	if (!holding) return "undelivered";

	// Baseline the produced-turn signal BEFORE submitting. A lane that has
	// ALREADY produced work (a resumed lane) carries a non-empty upload counter
	// from prior turns, so "non-empty after submit" would be true at baseline and
	// prove nothing about THIS submit. A fresh lane's counter is empty at baseline
	// and gains a figure on the first turn — that transition is the proof this
	// submit landed.
	const baselineProduced = await captureProducedTurn(paneId, cliKind);

	// SUBMIT, confirming the TUI consumed the input (composer empties). Retries
	// the bare Enter within a deadline: bracketed-paste mode may treat the first
	// Enter as a newline inside the buffer, so another Enter is the submit, and a
	// TUI still settling mid-render can swallow one. Retrying Enter alone is safe
	// — if an earlier one landed, the composer is empty and an extra Enter on an
	// empty composer is a no-op.
	const submitDeadline = Math.min(Date.now() + SUBMIT_DEADLINE_MS, budgetDeadline);
	let submitted = false;
	while (Date.now() < submitDeadline) {
		if ((await waitForPromptReady(paneId, submitDeadline)) === "vanished") return "vanished";
		const sent = send(["send-keys", "-t", paneId, "Enter"]);
		if ((sent.exitCode ?? 1) !== 0) return "undelivered";
		await Bun.sleep(SUBMIT_SETTLE_MS);
		const state = composerState(paneId);
		if (state === "gone") return "vanished";
		if (state === "empty") {
			submitted = true;
			break;
		}
	}
	if (!submitted) return "undelivered";

	// VERIFY A PRODUCED TURN for a fresh lane (empty at baseline). A resumed lane
	// already carried a figure at baseline — its prior turns — so its proof is the
	// composer transition above; the cumulative counter cannot distinguish this
	// submit's turn from earlier ones, and requiring it to would false-fail a
	// resumed lane whose continuation prompt is processed quickly.
	if (baselineProduced) return "delivered";
	const turnDeadline = Math.min(Date.now() + TURN_VERIFY_MS, budgetDeadline);
	while (Date.now() < turnDeadline) {
		if (await captureProducedTurn(paneId, cliKind)) return "delivered";
		await Bun.sleep(TURN_VERIFY_POLL_MS);
	}
	logger.warn(
		`[prompt-delivery] ${paneId} brief submitted (composer emptied) but no turn produced within ${TURN_VERIFY_MS}ms — reporting undelivered`,
	);
	return "undelivered";
}

/** What the pane's input line holds right now. */
type ComposerState = "empty" | "holding" | "gone";

function composerState(paneId: string): ComposerState {
	const cursor = spawnSync({
		name: "tmux:cursor-y",
		command: ["tmux", "display-message", "-p", "-t", paneId, "#{cursor_y}"],
		timeoutMs: 5_000,
	});
	if ((cursor.exitCode ?? 1) !== 0) return "gone";
	const y = Number.parseInt(String(cursor.stdout ?? "").trim(), 10);
	if (!Number.isFinite(y)) return "gone";

	const shot = spawnSync({
		name: "tmux:composer-line",
		// -J rejoins tmux's hard-wrapped rows so a long brief reads contiguously.
		command: ["tmux", "capture-pane", "-p", "-J", "-t", paneId, "-S", String(y), "-E", String(y)],
		timeoutMs: 5_000,
	});
	if ((shot.exitCode ?? 1) !== 0) return "gone";

	return composerLineIsEmpty(String(shot.stdout ?? "")) ? "empty" : "holding";
}

/**
 * True when a captured composer row carries no user text — only prompt chrome.
 *
 * Exported for its own test: this predicate decides whether a brief is re-sent,
 * so both directions are damage. Too strict and a delivered brief is typed a
 * second time into a working lane; too loose and a stuck lane is reported as
 * started and silently does nothing, which is the failure being fixed.
 */
export function composerLineIsEmpty(line: string): boolean {
	const stripped = line
		// Prompt markers and box-drawing chrome that render on an EMPTY composer.
		.replace(/[>❯▌│┃|╭╮╰╯─━┄┅]/gu, "")
		.trim();
	return stripped.length === 0;
}

const DELIVERY_BUDGET_MS = 100_000;
/** How long to keep re-pasting / re-submitting before failing the delivery. */
const SUBMIT_DEADLINE_MS = 90_000;
/** How long to let a submitted brief visibly change before judging it unsent. */
const SUBMIT_SETTLE_MS = 2_000;
/** How long to wait for a submitted brief to start a turn the pane can show. */
const TURN_VERIFY_MS = 30_000;
/** Gap between produced-turn samples while waiting for a turn to register. */
const TURN_VERIFY_POLL_MS = 1_500;

/** Pane content, or null when tmux no longer knows the pane. */
async function capturePane(paneId: string): Promise<string | null> {
	const cap = await spawn({
		name: "tmux:capture-pane",
		command: ["tmux", "capture-pane", "-p", "-t", paneId],
		timeoutMs: 5_000,
	});
	if ((cap.exitCode ?? 1) !== 0) return null;
	return cap.stdout.toString().trimEnd();
}

/**
 * Whether the pane shows evidence of a PRODUCED TURN right now — a turn the lane
 * actually took, not merely an alive pane. Delegates to `paneProducedTurn`
 * (pane-inventory) so the per-CLI produced-turn signal has one canonical home
 * and the spawn path and the fleet dashboard read the same fact.
 */
export async function captureProducedTurn(paneId: string, cliKind: CliKind): Promise<boolean> {
	const cap = await capturePane(paneId);
	if (cap === null) return false;
	return paneProducedTurn(cap.split("\n"), cliKind);
}
