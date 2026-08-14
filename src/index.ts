import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_MAX_TURNS = 20;
// Identical gap fingerprints in a row before the goal auto-pauses.
// Grok Build's GOAL_CLASSIFIER_STALL_THRESHOLD: two means nothing changed
// between attempts, iterating further is futile.
const STALL_THRESHOLD = 2;
const ENTRY_TYPE = "pi-quest";

export type GoalStatus = "active" | "user_paused" | "no_progress_paused" | "budget_paused" | "blocked" | "complete";

export interface GoalState {
	objective: string;
	status: GoalStatus;
	/** Settled agent runs since creation. */
	round: number;
	/** Auto-continuations sent. Capped by maxTurns. */
	autoTurns: number;
	maxTurns: number;
	/** User typed while active → stop auto-continuing until /goal resume. */
	suspended: boolean;
	lastGapFingerprint?: string;
	lastGaps?: string[];
	stallCount: number;
	/** Human-readable why, set on paused-family transitions. */
	pauseReason?: string;
}

export interface GoalVerdict {
	achieved: boolean;
	gaps: string[];
	/** false → every gap is non-model-fixable → blocked, pause for user. */
	modelFixable: boolean;
	blocker?: string;
}

export type GoalVerifier = (objective: string, round: number) => Promise<GoalVerdict>;

// ponytail: v0.1 stub — never verifies, so goals can only exit via pause/clear
// or the turn cap. Real execution-grounded skeptic (spawn `pi -p` with the
// objective + git diff, parse a JSON verdict) lands next; the Verifier
// interface is the seam.
const stubVerifier: GoalVerifier = async () => ({ achieved: false, gaps: [], modelFixable: true });

function isPaused(status: GoalStatus): boolean {
	return status !== "active" && status !== "complete";
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function gapFingerprint(gaps: string[]): string {
	const normalized = gaps
		.map((g) => g.replace(/\s+/g, " ").trim().toLowerCase())
		.sort()
		.join("\n");
	return hash(normalized);
}

interface Ui {
	setStatus?: (key: string, text: string) => void;
	notify?: (message: string, type?: "error" | "info" | "warning") => void;
}

interface SettleContext {
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
	ui?: Ui;
}

export function createQuest(pi: ExtensionAPI, verify: GoalVerifier): void {
	let goal: GoalState | undefined;

	function statusText(): string {
		if (!goal) return "";
		if (goal.status === "active") {
			const suspended = goal.suspended ? " ⏸ typing-suspended" : "";
			return `🎯 r${goal.round} auto ${goal.autoTurns}/${goal.maxTurns}${suspended}`;
		}
		if (goal.status === "complete") return "🎯 complete";
		return `🎯 ${goal.status.replace("_", " ")}`;
	}

	function syncUi(ctx: { ui?: Ui }): void {
		ctx.ui?.setStatus?.("pi-quest", statusText());
	}

	function persist(): void {
		if (goal) pi.appendEntry(ENTRY_TYPE, JSON.parse(JSON.stringify(goal)));
	}

	function transition(status: GoalStatus, reason: string | undefined, ctx: { ui?: Ui }): void {
		if (!goal) return;
		goal.status = status;
		if (reason === undefined) delete goal.pauseReason;
		else goal.pauseReason = reason;
		persist();
		syncUi(ctx);
		if (status !== "active") {
			ctx.ui?.notify?.(`🎯 goal ${status.replace("_", " ")}${reason ? `: ${reason}` : ""}`, "info");
		}
	}

	function continuationText(): string {
		if (!goal) return "";
		const gaps = goal.lastGaps ?? [];
		const gapSection = gaps.length > 0 ? `\nVerifier gaps to fix first:\n${gaps.map((g) => `- ${g}`).join("\n")}` : "";
		return (
			`[goal round ${goal.round}] Objective: ${goal.objective}${gapSection}\n` +
			"Continue working toward the objective. Make real, verifiable progress this round."
		);
	}

	async function continueGoal(ctx: SettleContext): Promise<void> {
		if (!goal) return;
		goal.autoTurns += 1;
		persist();
		syncUi(ctx);
		await pi.sendUserMessage(continuationText(), { deliverAs: "followUp" });
	}

	async function onSettled(ctx: SettleContext): Promise<void> {
		if (!goal || goal.status !== "active" || goal.suspended) return;
		if (ctx.isIdle?.() === false || ctx.hasPendingMessages?.() === true) return;

		goal.round += 1;

		// Fail-open: a broken verifier never blocks or silently completes the
		// goal. The round counts as unverified, the loop continues.
		let verdict: GoalVerdict | undefined;
		try {
			verdict = await verify(goal.objective, goal.round);
		} catch {
			verdict = undefined;
		}

		if (verdict?.achieved) {
			transition("complete", undefined, ctx);
			return;
		}
		if (verdict && !verdict.modelFixable) {
			transition("blocked", verdict.blocker ?? "verifier reports non-model-fixable gaps", ctx);
			return;
		}
		if (verdict && verdict.gaps.length > 0) {
			goal.lastGaps = verdict.gaps;
			const fingerprint = gapFingerprint(verdict.gaps);
			if (fingerprint === goal.lastGapFingerprint) {
				goal.stallCount += 1;
			} else {
				goal.lastGapFingerprint = fingerprint;
				goal.stallCount = 1;
			}
			if (goal.stallCount >= STALL_THRESHOLD) {
				transition("no_progress_paused", "same verifier gaps twice in a row", ctx);
				return;
			}
		} else if (verdict) {
			// A clean round clears stale gaps so the next continuation
			// never replays already-fixed feedback.
			delete goal.lastGaps;
		}

		if (goal.autoTurns >= goal.maxTurns) {
			transition("budget_paused", `${goal.maxTurns} auto-continuations used up`, ctx);
			await pi.sendUserMessage(
				`[goal] Auto-paused after ${goal.maxTurns} continuations. ` +
					"Summarize what is done, what remains, and what you would need to finish.",
				{ deliverAs: "followUp" },
			);
			return;
		}

		await continueGoal(ctx);
	}

	function parseSetArgs(args: string): { objective: string; maxTurns: number } | undefined {
		const match = args.match(/--max-turns\s+(\d+)/);
		const maxTurns = match?.[1] ? Number.parseInt(match[1], 10) : DEFAULT_MAX_TURNS;
		const objective = args.replace(/--max-turns\s+\d+/, "").trim();
		if (!objective || !Number.isFinite(maxTurns) || maxTurns <= 0) return undefined;
		return { objective, maxTurns };
	}

	pi.registerCommand("goal", {
		description: "Set a persistent goal: /goal <objective> [--max-turns N] | status | pause | resume | clear",
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] ?? "";

			if (sub === "status") {
				const text = goal
					? `${goal.status} | round ${goal.round} | auto ${goal.autoTurns}/${goal.maxTurns}` +
						(goal.pauseReason ? ` | ${goal.pauseReason}` : "") +
						`\n${goal.objective}`
					: "no goal set";
				ctx.ui.notify(text, "info");
				return;
			}
			if (sub === "pause") {
				if (goal?.status === "active") transition("user_paused", "paused by user", ctx);
				return;
			}
			if (sub === "resume") {
				if (goal && (isPaused(goal.status) || goal.suspended)) {
					goal.suspended = false;
					transition("active", undefined, ctx);
					await continueGoal(ctx);
				}
				return;
			}
			if (sub === "clear") {
				// Tombstone: without it the last persisted snapshot would
				// resurrect the goal on the next session restore.
				pi.appendEntry(ENTRY_TYPE, { status: "cleared" });
				goal = undefined;
				syncUi(ctx);
				ctx.ui.notify("🎯 goal cleared", "info");
				return;
			}
			if (sub === "help" || !args.trim()) {
				ctx.ui.notify(
					"/goal <objective> [--max-turns N] — set a goal and loop until verified done\n" +
						"/goal status | pause | resume | clear",
					"info",
				);
				return;
			}

			const parsed = parseSetArgs(args);
			if (!parsed) {
				ctx.ui.notify("usage: /goal <objective> [--max-turns N]", "error");
				return;
			}
			goal = {
				objective: parsed.objective,
				status: "active",
				round: 0,
				autoTurns: 0,
				maxTurns: parsed.maxTurns,
				suspended: false,
				stallCount: 0,
			};
			persist();
			syncUi(ctx);
			ctx.ui.notify(`🎯 goal set (cap ${goal.maxTurns} auto-continuations)`, "info");
			await pi.sendUserMessage(`[goal] Objective: ${goal.objective}\nStart working toward it now.`, {
				deliverAs: "followUp",
			});
		},
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await onSettled(ctx);
	});

	// A typed user message redirects the agent: suspend auto-continuation until
	// /goal resume. Our own continuations arrive with source "extension" and
	// must not suspend the loop.
	pi.on("message_end", async (event, ctx) => {
		const source = (event as { source?: string }).source;
		if (event.message?.role === "user" && source !== "extension" && goal?.status === "active" && !goal.suspended) {
			goal.suspended = true;
			persist();
			syncUi(ctx);
		}
	});

	pi.on("session_start", async (event, ctx) => {
		goal = undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE && entry.data) {
				const data = entry.data as GoalState | { status: "cleared" };
				goal = data.status === "cleared" ? undefined : (data as GoalState);
			}
		}
		// Grok discipline: a restored goal never silently re-arms as a
		// self-driving loop. /reload keeps continuity; every other start
		// reason forces user_paused.
		if (goal?.status === "active" && event.reason !== "reload") {
			goal.status = "user_paused";
			goal.pauseReason = "restored from a previous session";
		}
		syncUi(ctx);
	});

	pi.on("session_shutdown", async () => {
		goal = undefined;
	});
}

export default function quest(pi: ExtensionAPI): void {
	createQuest(pi, stubVerifier);
}
