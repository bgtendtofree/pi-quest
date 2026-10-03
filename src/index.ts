import { createHash } from "node:crypto";
import type {
	AgentBeforeSettleEvent,
	BoundaryResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { captureBaseline, createSkepticVerifier, VerificationError, verificationFailure } from "./verifier.ts";

const DEFAULT_MAX_TURNS = 20;
// Identical gap fingerprints in a row before the goal auto-pauses.
// Two means nothing changed between attempts; iterating further is futile.
const STALL_THRESHOLD = 2;
const ENTRY_TYPE = "pi-quest";
const TEXT_LIMIT = 512;
const GAPS_LIMIT = 10;

const VerificationSchema = Type.Object({
	outcome: Type.Union([
		Type.Literal("verified-achieved"),
		Type.Literal("verified-incomplete"),
		Type.Literal("unverified"),
	]),
	round: Type.Integer({ minimum: 1 }),
	durationMs: Type.Integer({ minimum: 0 }),
	model: Type.Optional(Type.String({ maxLength: 200 })),
	gaps: Type.Array(Type.String({ maxLength: TEXT_LIMIT }), { maxItems: GAPS_LIMIT }),
	truncated: Type.Boolean(),
	failure: Type.Optional(
		Type.Object({
			kind: Type.Union([
				Type.Literal("timeout"),
				Type.Literal("process"),
				Type.Literal("model"),
				Type.Literal("output"),
			]),
			reason: Type.String({ maxLength: TEXT_LIMIT }),
		}),
	),
});

export type GoalVerification = Static<typeof VerificationSchema>;

const GoalViewSchema = Type.Object({
	goal: Type.Union([
		Type.Null(),
		Type.Object({
			objective: Type.String({ maxLength: 4096 }),
			status: Type.String(),
			suspended: Type.Boolean(),
			round: Type.Integer({ minimum: 0 }),
			remainingTurns: Type.Integer({ minimum: 0 }),
			lastGaps: Type.Array(Type.String({ maxLength: TEXT_LIMIT }), { maxItems: GAPS_LIMIT }),
			pauseReason: Type.Optional(Type.String({ maxLength: TEXT_LIMIT })),
			lastVerification: Type.Optional(VerificationSchema),
			truncated: Type.Boolean(),
		}),
	]),
});

export type GoalView = Static<typeof GoalViewSchema>;

function boundedGaps(gaps: string[]): { gaps: string[]; truncated: boolean } {
	return {
		gaps: gaps.slice(0, GAPS_LIMIT).map((gap) => gap.slice(0, TEXT_LIMIT)),
		truncated: gaps.length > GAPS_LIMIT || gaps.some((gap) => gap.length > TEXT_LIMIT),
	};
}

function restoreVerification(value: unknown, round: number): GoalVerification | undefined {
	if (!value || typeof value !== "object") return;
	const raw = value as Record<string, unknown>;
	if (
		!["verified-achieved", "verified-incomplete", "unverified"].includes(raw.outcome as string) ||
		!Number.isSafeInteger(raw.round) ||
		(raw.round as number) < 1 ||
		(raw.round as number) > round ||
		!Number.isSafeInteger(raw.durationMs) ||
		(raw.durationMs as number) < 0 ||
		!Array.isArray(raw.gaps) ||
		!raw.gaps.every((gap) => typeof gap === "string") ||
		typeof raw.truncated !== "boolean" ||
		(raw.model !== undefined && typeof raw.model !== "string")
	)
		return;
	let failure: GoalVerification["failure"];
	if (raw.outcome === "unverified") {
		const kind = (raw.failure as { kind?: unknown } | null)?.kind;
		if (kind !== "timeout" && kind !== "process" && kind !== "model" && kind !== "output") return;
		// Rebuild safe diagnostics, never replay arbitrary persisted error text.
		failure = { kind, reason: verificationFailure(new VerificationError(kind)).reason };
	}
	const bounded = boundedGaps(raw.gaps as string[]);
	return {
		outcome: raw.outcome as GoalVerification["outcome"],
		round: raw.round as number,
		durationMs: raw.durationMs as number,
		...bounded,
		truncated: raw.truncated || bounded.truncated,
		...(typeof raw.model === "string" ? { model: raw.model.slice(0, 200) } : {}),
		...(failure ? { failure } : {}),
	};
}

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
	/** Working directory captured at goal creation; the skeptic runs here. */
	cwd: string;
	/** `git rev-parse HEAD` at creation; the skeptic diffs against it. */
	baselineCommit?: string;
	lastGapFingerprint?: string;
	lastGaps?: string[];
	stallCount: number;
	/** Human-readable why, set on paused-family transitions. */
	pauseReason?: string;
	/** Bounded, branch-local summary; no raw subprocess diagnostics. */
	lastVerification?: GoalVerification;
}

export interface GoalVerdict {
	achieved: boolean;
	gaps: string[];
	/** false → every gap is non-model-fixable → blocked, pause for user. */
	modelFixable: boolean;
	blocker?: string;
	/** Actual physical verifier model, when reported by the child. */
	model?: string;
}

export type GoalVerifier = (objective: string, round: number, signal?: AbortSignal) => Promise<GoalVerdict>;

/** Builds the verifier for one goal (its cwd + baseline are baked in). */
export type GoalVerifierFactory = (goal: GoalState, ctx: ExtensionContext) => GoalVerifier;

const GOAL_STATUSES = new Set<GoalStatus>([
	"active",
	"user_paused",
	"no_progress_paused",
	"budget_paused",
	"blocked",
	"complete",
]);

function isGoalStatus(value: unknown): value is GoalStatus {
	return typeof value === "string" && GOAL_STATUSES.has(value as GoalStatus);
}

function restoreState(value: unknown): GoalState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (
		typeof raw.objective !== "string" ||
		!Number.isSafeInteger(raw.round) ||
		(raw.round as number) < 0 ||
		!Number.isSafeInteger(raw.autoTurns) ||
		(raw.autoTurns as number) < 0 ||
		!Number.isSafeInteger(raw.maxTurns) ||
		(raw.maxTurns as number) <= 0 ||
		typeof raw.suspended !== "boolean" ||
		typeof raw.cwd !== "string" ||
		!Number.isSafeInteger(raw.stallCount) ||
		(raw.stallCount as number) < 0 ||
		(raw.baselineCommit !== undefined && typeof raw.baselineCommit !== "string") ||
		(raw.lastGapFingerprint !== undefined && typeof raw.lastGapFingerprint !== "string") ||
		(raw.lastGaps !== undefined &&
			(!Array.isArray(raw.lastGaps) || !raw.lastGaps.every((gap) => typeof gap === "string"))) ||
		(raw.pauseReason !== undefined && typeof raw.pauseReason !== "string")
	)
		return undefined;
	const restored: GoalState = {
		...(value as GoalState),
		status: isGoalStatus(raw.status) ? raw.status : "user_paused",
		...(isGoalStatus(raw.status) ? {} : { pauseReason: "invalid persisted status" }),
	};
	delete restored.lastVerification;
	const verification = restoreVerification(raw.lastVerification, restored.round);
	if (verification) restored.lastVerification = verification;
	return restored;
}

function isPaused(status: GoalStatus): boolean {
	return status !== "active" && status !== "complete";
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function gapFingerprint(gaps: string[]): string {
	const normalized = [...new Set(gaps.map((g) => g.replace(/\s+/g, " ").trim().toLowerCase()))].sort().join("\n");
	return hash(normalized);
}

export function createQuest(pi: ExtensionAPI, makeVerifier: GoalVerifierFactory): void {
	let goal: GoalState | undefined;
	let verify: GoalVerifier | undefined;
	let goalVersion = 0;
	let verificationAbort: AbortController | undefined;
	let lastRunAborted = false;

	function goalView(): GoalView {
		if (!goal) return { goal: null };
		const gaps = boundedGaps(goal.lastGaps ?? []);
		return {
			goal: {
				objective: goal.objective.slice(0, 4096),
				status: goal.status,
				suspended: goal.suspended,
				round: goal.round,
				remainingTurns: Math.max(0, goal.maxTurns - goal.autoTurns),
				lastGaps: gaps.gaps,
				...(goal.pauseReason ? { pauseReason: goal.pauseReason.slice(0, TEXT_LIMIT) } : {}),
				...(goal.lastVerification ? { lastVerification: structuredClone(goal.lastVerification) } : {}),
				truncated: gaps.truncated || goal.objective.length > 4096 || (goal.pauseReason?.length ?? 0) > TEXT_LIMIT,
			},
		};
	}

	pi.registerTool({
		name: "quest_get_goal",
		label: "Quest Goal",
		description:
			"Read the current goal, state, remaining continuations, verifier gaps and latest verification. Read-only; never starts, resumes, replaces or completes a goal. truncated=true marks omitted text.",
		parameters: Type.Object({}, { additionalProperties: false }),
		outputSchema: GoalViewSchema,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute() {
			const snapshot = goalView();
			return {
				content: [{ type: "text", text: JSON.stringify(snapshot) }],
				details: snapshot,
				structuredContent: snapshot,
			};
		},
	});

	function invalidate(): number {
		goalVersion += 1;
		verificationAbort?.abort();
		verificationAbort = undefined;
		return goalVersion;
	}

	function statusText(): string {
		if (!goal) return "";
		if (goal.status === "active") {
			const suspended = goal.suspended ? " ⏸ typing-suspended" : "";
			return `🎯 r${goal.round} auto ${goal.autoTurns}/${goal.maxTurns}${suspended}`;
		}
		if (goal.status === "complete") return "🎯 complete";
		return `🎯 ${goal.status.replace("_", " ")}`;
	}

	function syncUi(ctx: ExtensionContext): void {
		ctx.ui.setStatus("pi-quest", goal ? statusText() : undefined);
	}

	function persist(): void {
		if (goal) pi.appendEntry(ENTRY_TYPE, structuredClone(goal));
	}

	function transition(status: GoalStatus, reason: string | undefined, ctx: ExtensionContext): void {
		if (!goal) return;
		goal.status = status;
		if (reason === undefined) delete goal.pauseReason;
		else goal.pauseReason = reason;
		persist();
		syncUi(ctx);
		if (status !== "active") {
			ctx.ui.notify(`🎯 goal ${status.replace("_", " ")}${reason ? `: ${reason}` : ""}`, "info");
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

	function continuation(ctx: ExtensionContext): string | undefined {
		if (goal?.status !== "active" || goal.suspended) return;
		if (goal.autoTurns >= goal.maxTurns) {
			transition("budget_paused", `${goal.maxTurns} auto-continuations used up`, ctx);
			return;
		}
		goal.autoTurns += 1;
		persist();
		syncUi(ctx);
		return continuationText();
	}

	function boundaryContinuation(event: AgentBeforeSettleEvent, content: string): BoundaryResult {
		return {
			entries: [
				...event.entries,
				{ type: "custom_message", customType: "pi-quest-continuation", content, display: true },
			],
			continue: true,
		};
	}

	async function onBeforeSettle(
		event: AgentBeforeSettleEvent,
		ctx: ExtensionContext,
	): Promise<BoundaryResult | undefined> {
		if (goal?.status !== "active" || goal.suspended) return;
		if (event.outcome !== "completed") {
			transition("user_paused", `agent run ${event.outcome}`, ctx);
			return;
		}
		if (event.continue || event.context.pendingMessages.length > 0 || ctx.hasPendingMessages()) return;
		if (verificationAbort) return;

		const settledGoal = goal;
		const settledVerify = verify;
		const settledVersion = goalVersion;
		const controller = new AbortController();
		verificationAbort = controller;
		const signal = ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;
		try {
			settledGoal.round += 1;
			// The skeptic runs 1-2 min; without this the UI looks hung (live-test lesson).
			ctx.ui.setStatus("pi-quest", `🎯 r${settledGoal.round} verifying…`);

			// Fail-open: a broken verifier never blocks or silently completes the
			// goal. The round counts as unverified, the loop continues.
			let verdict: GoalVerdict | undefined;
			let failure: ReturnType<typeof verificationFailure> | undefined;
			const startedAt = performance.now();
			try {
				if (!settledVerify) throw new Error("verifier unavailable");
				verdict = await settledVerify(settledGoal.objective, settledGoal.round, signal);
			} catch (error) {
				failure = verificationFailure(error);
			}

			// User control may have changed or replaced goal while skeptic ran.
			// Never apply old verdict to current goal.
			if (
				goal !== settledGoal ||
				goalVersion !== settledVersion ||
				settledGoal.status !== "active" ||
				settledGoal.suspended
			)
				return;
			syncUi(ctx);
			if (signal.aborted) {
				transition("user_paused", "verification cancelled", ctx);
				return;
			}
			if (ctx.hasPendingMessages()) {
				persist();
				return;
			}

			const model = verdict?.model ?? failure?.model;
			goal.lastVerification = {
				outcome: verdict ? (verdict.achieved ? "verified-achieved" : "verified-incomplete") : "unverified",
				round: settledGoal.round,
				durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
				...boundedGaps(verdict?.gaps ?? []),
				...(model ? { model: model.slice(0, 200) } : {}),
				...(failure ? { failure: { kind: failure.kind, reason: failure.reason } } : {}),
			};
			if (verdict) {
				if (verdict.gaps.length > 0) goal.lastGaps = [...verdict.gaps];
				else delete goal.lastGaps;
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
			} else {
				// A clean or unverified round breaks consecutive-gap detection.
				delete goal.lastGapFingerprint;
				goal.stallCount = 0;
			}

			if (goal.autoTurns >= goal.maxTurns) {
				transition("budget_paused", `${goal.maxTurns} auto-continuations used up`, ctx);
				return boundaryContinuation(
					event,
					`[goal] Auto-paused after ${goal.maxTurns} continuations. ` +
						"Summarize what is done, what remains, and what you would need to finish.",
				);
			}

			const text = continuation(ctx);
			return text ? boundaryContinuation(event, text) : undefined;
		} finally {
			if (verificationAbort === controller) verificationAbort = undefined;
		}
	}

	function parseSetArgs(args: string): { objective: string; maxTurns: number } | undefined {
		const flags = [...args.matchAll(/(?:^|\s)--max-turns\b/g)];
		const match = args.match(/(?:^|\s)--max-turns(?:\s+|=)(\d+)(?=\s|$)/);
		if (flags.length > 1 || (flags.length === 1 && !match)) return undefined;
		const maxTurns = match?.[1] ? Number.parseInt(match[1], 10) : DEFAULT_MAX_TURNS;
		const objective = (match ? args.replace(match[0], "") : args).trim();
		if (!objective || !Number.isSafeInteger(maxTurns) || maxTurns <= 0) return undefined;
		return { objective, maxTurns };
	}

	pi.registerCommand("goal", {
		description: "Set a persistent goal: /goal <objective> [--max-turns N] | status | pause | resume | clear",
		handler: async (args, ctx) => {
			const sub = args.trim();

			if (sub === "status") {
				const text = goal
					? `${goal.status} | round ${goal.round} | auto ${goal.autoTurns}/${goal.maxTurns}` +
						(goal.pauseReason ? ` | ${goal.pauseReason}` : "") +
						`\n${goal.objective}`
					: "no goal set";
				const latest = goal?.lastVerification;
				const verification = latest
					? `\nVerification r${latest.round}: ${latest.outcome} | ${latest.durationMs}ms` +
						(latest.model ? ` | ${latest.model}` : "") +
						(latest.failure ? ` | ${latest.failure.kind}: ${latest.failure.reason}` : "") +
						(latest.gaps.length ? `\n${latest.gaps.join("\n")}${latest.truncated ? "\n(truncated)" : ""}` : "")
					: "";
				ctx.ui.notify(text + verification, "info");
				return;
			}
			if (sub === "pause") {
				if (goal?.status === "active") {
					invalidate();
					transition("user_paused", "paused by user", ctx);
				}
				return;
			}
			if (sub === "resume") {
				if (goal?.status === "budget_paused") {
					ctx.ui.notify("🎯 budget exhausted; set a new goal", "warning");
					return;
				}
				if (goal && (isPaused(goal.status) || goal.suspended)) {
					invalidate();
					goal.suspended = false;
					goal.stallCount = 0;
					delete goal.lastGapFingerprint;
					verify = makeVerifier(goal, ctx);
					transition("active", undefined, ctx);
					const text = continuation(ctx);
					if (text) pi.sendUserMessage(text, { deliverAs: "followUp" });
				}
				return;
			}
			if (sub === "clear") {
				// Tombstone: without it the last persisted snapshot would
				// resurrect the goal on the next session restore.
				invalidate();
				pi.appendEntry(ENTRY_TYPE, { status: "cleared" });
				goal = undefined;
				verify = undefined;
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
			const version = invalidate();
			goal = undefined;
			verify = undefined;
			const baselineCommit = await captureBaseline((c, a, o) => pi.exec(c, a, o), ctx.cwd);
			if (goalVersion !== version) return;
			goal = {
				objective: parsed.objective,
				status: "active",
				round: 0,
				autoTurns: 0,
				maxTurns: parsed.maxTurns,
				suspended: false,
				cwd: ctx.cwd,
				...(baselineCommit ? { baselineCommit } : {}),
				stallCount: 0,
			};
			verify = makeVerifier(goal, ctx);
			persist();
			syncUi(ctx);
			ctx.ui.notify(`🎯 goal set (cap ${goal.maxTurns} auto-continuations)`, "info");
			pi.sendUserMessage(`[goal] Objective: ${goal.objective}\nStart working toward it now.`, {
				deliverAs: "followUp",
			});
		},
	});

	pi.on("agent_before_settle", onBeforeSettle);

	// Esc bypasses agent_before_settle. Observe cancellation without restarting
	// from the notification-only agent_settled hook.
	pi.on("agent_start", () => {
		lastRunAborted = false;
	});
	pi.on("agent_end", (event) => {
		lastRunAborted = event.messages.some((message) => message.role === "assistant" && message.stopReason === "aborted");
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (lastRunAborted && goal?.status === "active") {
			invalidate();
			transition("user_paused", "agent run aborted", ctx);
		}
	});

	// A typed user message redirects the agent: suspend auto-continuation until
	// /goal resume. Input events expose source, so extension messages from this
	// plugin or other extensions do not look like human input.
	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return;
		if (goal?.status === "active" && !goal.suspended) {
			invalidate();
			goal.suspended = true;
			persist();
			syncUi(ctx);
		}
	});

	function restoreGoal(
		entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>,
		pauseActive: boolean,
		ctx: ExtensionContext,
	): void {
		const entry = entries.findLast((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE);
		goal = restoreState(entry?.data);
		if (goal?.status === "active" && pauseActive) {
			goal.status = "user_paused";
			goal.pauseReason = "restored from a previous session";
		}
		if (goal && entry && (entry.data as GoalState).status !== goal.status) persist();
		verify = goal ? makeVerifier(goal, ctx) : undefined;
	}

	pi.on("session_start", async (event, ctx) => {
		invalidate();
		restoreGoal(ctx.sessionManager.getBranch(), event.reason !== "reload", ctx);
		syncUi(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		invalidate();
		restoreGoal(ctx.sessionManager.getBranch(), true, ctx);
		syncUi(ctx);
	});

	pi.on("session_shutdown", async () => {
		invalidate();
		goal = undefined;
		verify = undefined;
	});
}

export default function quest(pi: ExtensionAPI): void {
	createQuest(pi, (goal, ctx) => async (objective, round, signal) => {
		// Virtual selections only exist in the host's extension runtime. Reuse
		// the physical model that did the work, including its routed effort.
		const entry = ctx.sessionManager
			.getBranch()
			.findLast(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.stopReason !== "error" &&
					entry.message.stopReason !== "aborted",
			);
		const response = entry?.type === "message" && entry.message.role === "assistant" ? entry.message : undefined;
		const model = response ? `${response.provider}/${response.model}` : undefined;
		const thinkingLevel = response?.thinkingLevel ?? ctx.thinkingLevel;
		return createSkepticVerifier((c, a, o) => pi.exec(c, a, o), goal, {
			...(model ? { model } : {}),
			...(thinkingLevel ? { thinkingLevel } : {}),
		})(objective, round, signal);
	});
}
