import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
	AgentBeforeSettleEvent,
	BoundaryResult,
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import quest, {
	createQuest,
	type GoalState,
	type GoalVerdict,
	type GoalVerifier,
	type GoalView,
} from "../src/index.ts";
import { collectRecords } from "../src/records.ts";
import { VerificationError } from "../src/verifier.ts";

interface Sent {
	content: string;
	options?: { deliverAs?: string };
}

function createPi(): {
	pi: ExtensionAPI;
	handlers: Map<string, Array<(event: never, ctx: never) => unknown>>;
	commands: Map<string, (args: string, ctx: never) => Promise<void>>;
	sent: Sent[];
	entries: Array<{ customType: string; data: unknown }>;
	tools: Map<string, ToolDefinition>;
} {
	const handlers = new Map();
	const commands = new Map();
	const sent: Sent[] = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		on(event: string, handler: (event: never, ctx: never) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name: string, def: { handler: (args: string, ctx: never) => Promise<void> }) {
			commands.set(name, def.handler);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerFlag() {},
		getFlag() {
			return false;
		},
		sendUserMessage(content: string, options?: Sent["options"]) {
			sent.push({ content, options });
			return Promise.resolve();
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
		// Not a git repo in tests → baseline capture yields undefined.
		exec() {
			return Promise.resolve({ stdout: "", stderr: "not a repo", code: 128, killed: false });
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, commands, sent, entries, tools };
}

interface Fixture {
	sent: Sent[];
	entries: Array<{ customType: string; data: unknown }>;
	statuses: string[];
	notifications: string[];
	query: () => Promise<GoalView>;
	setGoal: (args: string) => Promise<void>;
	cmd: (args: string) => Promise<void>;
	settle: (event?: Partial<AgentBeforeSettleEvent>) => Promise<BoundaryResult | undefined>;
	fire: (event: string, payload?: unknown) => Promise<unknown>;
	userTypes: () => Promise<void>;
	ownMessage: () => Promise<void>;
	lastGoal: () => GoalState | undefined;
}

function fixture(
	verdicts: Array<GoalVerdict | Error>,
	opts?: {
		entries?: Array<{ customType: string; data: unknown }>;
		branchEntries?: Array<{ customType: string; data: unknown }>;
		startReason?: string;
		pending?: boolean;
		signal?: AbortSignal;
		verifier?: GoalVerifier;
		exec?: ExtensionAPI["exec"];
	},
): Fixture {
	const { pi, handlers, commands, sent, entries, tools } = createPi();
	if (opts?.exec) pi.exec = opts.exec;
	let call = 0;
	createQuest(
		pi,
		() =>
			opts?.verifier ??
			(async () => {
				const next = verdicts[Math.min(call, verdicts.length - 1)];
				call += 1;
				if (next instanceof Error) throw next;
				return next ?? { achieved: false, gaps: [], modelFixable: true };
			}),
	);

	const statuses: Array<string | undefined> = [];
	const notifications: string[] = [];
	const ctx = {
		cwd: "/tmp/quest-test",
		isIdle: () => true,
		hasPendingMessages: () => opts?.pending ?? false,
		signal: opts?.signal,
		ui: {
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			notify: (text: string) => notifications.push(text),
		},
		sessionManager: {
			getEntries: () => (opts?.entries ?? []).map((e) => ({ type: "custom", customType: e.customType, data: e.data })),
			getBranch: () =>
				(opts?.branchEntries ?? opts?.entries ?? []).map((e) => ({
					type: "custom",
					customType: e.customType,
					data: e.data,
				})),
		},
	};

	const fire = async (event: string, payload: unknown = {}) => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = await handler(payload as never, ctx as never);
		return result;
	};

	return {
		sent,
		entries,
		statuses,
		notifications,
		query: async () => {
			const tool = tools.get("quest_get_goal");
			assert.ok(tool);
			const result = await tool.execute("query", {}, undefined, undefined as never, ctx as never);
			assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), result.structuredContent);
			assert.deepEqual(result.details, result.structuredContent);
			return result.structuredContent as GoalView;
		},
		setGoal: async (args) => {
			await fire("session_start", { reason: opts?.startReason ?? "startup" });
			const handler = commands.get("goal");
			assert.ok(handler);
			await handler(args, ctx as never);
		},
		cmd: async (args) => {
			const handler = commands.get("goal");
			assert.ok(handler);
			await handler(args, ctx as never);
		},
		settle: async (event = {}) => {
			const result = (await fire("agent_before_settle", {
				entries: [],
				continue: false,
				context: { pendingMessages: [] },
				outcome: "completed",
				...event,
			})) as BoundaryResult | undefined;
			for (const entry of result?.entries ?? []) {
				if (entry.type === "custom_message" && typeof entry.content === "string") sent.push({ content: entry.content });
			}
			return result;
		},
		fire,
		userTypes: async () => {
			await fire("input", { source: "interactive", text: "redirect" });
		},
		ownMessage: async () => {
			await fire("input", { source: "extension", text: "[goal round 1] Objective: x" });
		},
		lastGoal: () => {
			const last = entries.filter((e) => e.customType === "pi-quest").at(-1);
			return last?.data as GoalState | undefined;
		},
	};
}

const notDone = (gaps: string[] = []): GoalVerdict => ({ achieved: false, gaps, modelFixable: true });

describe("execution accounting", () => {
	const usage = {
		input: 10,
		output: 2,
		cacheRead: 3,
		cacheWrite: 1,
		totalTokens: 16,
		cost: { total: 0.01 },
	};
	const records = collectRecords(
		[
			JSON.stringify({ type: "message_end", message: { role: "assistant", usage } }),
			JSON.stringify({ type: "agent_settled" }),
		].join("\n"),
	);

	test("main and verifier remain separate; repeated event channels do not double-count", async () => {
		const f = fixture([], {
			verifier: async (_objective, _round, _signal, report) => {
				report?.(records);
				throw new VerificationError("output");
			},
		});
		await f.setGoal("document API");
		await f.fire("turn_start");
		const message = { role: "assistant", usage };
		const toolResult = { role: "toolResult", usage };
		await f.fire("message_end", { message });
		await f.fire("tool_execution_end", { result: { usage } });
		const end = { message, toolResults: [toolResult] };
		await f.fire("turn_end", end);
		await f.fire("turn_end", end);
		await f.fire("agent_end", { messages: [message, toolResult] });
		await f.settle();
		const snapshot = f.lastGoal();
		assert.equal(snapshot?.accounting?.main.runs, 1);
		assert.equal(snapshot?.accounting?.main.usage.totalTokens, 32);
		assert.equal(snapshot?.accounting?.verifier.runs, 1);
		assert.equal(snapshot?.accounting?.verifier.usage.totalTokens, 16);
		assert.equal(snapshot?.lastVerification?.outcome, "unverified");
		assert.deepEqual(snapshot?.lastVerification?.records, records);
		const query = await f.query();
		assert.ok(query.goal?.accounting);
		query.goal.accounting.main.usage.totalTokens = 0;
		assert.equal((await f.query()).goal?.accounting?.main.usage.totalTokens, 32);
		await f.cmd("status");
		assert.match(f.notifications.at(-1) ?? "", /main:.*tokens 32/);
		assert.match(f.notifications.at(-1) ?? "", /verifier:.*tokens 16/);
	});

	test("cancelled verifier stays an incomplete attempt; late receipts cannot write summaries or usage", async () => {
		let finish: (() => void) | undefined;
		const f = fixture([], {
			verifier: async (_objective, _round, _signal, report) => {
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				report?.(records);
				return { achieved: true, gaps: [], modelFixable: true };
			},
		});
		await f.setGoal("x");
		const pending = f.settle();
		await f.cmd("pause");
		const entries = f.entries.length;
		assert.ok(finish);
		finish();
		await pending;
		assert.equal(f.entries.length, entries);
		assert.equal(f.lastGoal()?.accounting?.verifier.runs, 1);
		assert.equal(f.lastGoal()?.accounting?.verifier.completedRuns, 0);
		assert.equal(f.lastGoal()?.accounting?.verifier.usage.totalTokens, undefined);
		assert.equal(f.lastGoal()?.lastVerification, undefined);
		await f.cmd("status");
		assert.match(f.notifications.at(-1) ?? "", /unknown \(partial\)/);
	});

	test("branch restoration keeps accounting and receipts; invalid optional metadata is dropped", async () => {
		const source = fixture([], {
			verifier: async (_objective, _round, _signal, report) => {
				report?.(records);
				return notDone();
			},
		});
		await source.setGoal("x");
		await source.settle();
		const state = source.lastGoal();
		assert.ok(state);
		const entries = [{ customType: "pi-quest", data: state }];
		const restored = fixture([], { entries, branchEntries: entries });
		await restored.fire("session_start");
		assert.deepEqual((await restored.query()).goal?.accounting, state.accounting);
		assert.deepEqual((await restored.query()).goal?.lastVerification?.records, records);
		const invalid = fixture([], {
			entries: [
				{
					customType: "pi-quest",
					data: {
						...state,
						accounting: { leaked: "SECRET" },
						lastVerification: { ...state.lastVerification, records: { ...records, stdout: "SECRET" } },
					},
				},
			],
		});
		await invalid.fire("session_start");
		assert.equal((await invalid.query()).goal?.accounting, undefined);
		assert.equal((await invalid.query()).goal?.lastVerification?.records, undefined);
		assert.ok((await invalid.query()).goal?.lastVerification);
	});

	test("late main results never charge replacement goals", async () => {
		const f = fixture([notDone()]);
		await f.setGoal("old");
		await f.fire("turn_start");
		await f.cmd("new");
		await f.fire("turn_end", { message: { role: "assistant", usage }, toolResults: [] });
		assert.equal(f.lastGoal()?.objective, "new");
		assert.equal(f.lastGoal()?.accounting, undefined);
	});
});

describe("goal query and verification summaries", () => {
	test("query is read-only, detached, and explicitly reports no goal", async () => {
		const f = fixture([notDone(["tests fail"])]);
		assert.deepEqual(await f.query(), { goal: null });
		assert.equal(f.entries.length, 0);
		assert.equal(f.sent.length, 0);
		await f.setGoal("refactor auth");
		await f.settle();
		const before = structuredClone(f.entries);
		const sent = f.sent.length;
		const snapshot = (await f.query()).goal;
		assert.ok(snapshot);
		assert.equal(snapshot.status, "active");
		assert.equal(snapshot.round, 1);
		assert.equal(snapshot.remainingTurns, 19);
		assert.equal(snapshot.lastVerification?.outcome, "verified-incomplete");
		snapshot.objective = "tampered";
		snapshot.lastGaps.push("tampered");
		snapshot.lastVerification?.gaps.push("tampered");
		assert.deepEqual(f.entries, before);
		assert.equal(f.sent.length, sent);
		assert.equal((await f.query()).goal?.objective, "refactor auth");
		assert.deepEqual((await f.query()).goal?.lastVerification?.gaps, ["tests fail"]);
		await f.cmd("clear");
		assert.deepEqual(await f.query(), { goal: null });
	});

	test("query reflects suspension and every terminal state without resuming", async () => {
		const suspended = fixture([]);
		await suspended.setGoal("document API");
		await suspended.userTypes();
		assert.equal((await suspended.query()).goal?.suspended, true);
		for (const status of ["user_paused", "no_progress_paused", "budget_paused", "blocked", "complete"] as const) {
			const f = fixture([
				status === "complete"
					? { achieved: true, gaps: [], modelFixable: true }
					: {
							achieved: false,
							gaps: status === "budget_paused" ? [] : ["missing section"],
							modelFixable: status !== "blocked",
							blocker: "decision",
						},
			]);
			await f.setGoal("document API --max-turns 1");
			if (status === "user_paused") await f.cmd("pause");
			else {
				await f.settle();
				if (status === "no_progress_paused" || status === "budget_paused") await f.settle();
			}
			const count = f.sent.length;
			assert.equal((await f.query()).goal?.status, status);
			assert.equal(f.sent.length, count);
			if (status === "budget_paused") assert.equal((await f.query()).goal?.remainingTurns, 0);
		}
	});

	test("large query text and summary gaps are bounded without changing the objective", async () => {
		const gaps = Array.from({ length: 30 }, () => "x".repeat(2000));
		const f = fixture([notDone(gaps)]);
		const objective = "x".repeat(20_000);
		await f.setGoal(objective);
		await f.settle();
		const snapshot = (await f.query()).goal;
		assert.equal(snapshot?.objective.length, 4096);
		assert.equal(snapshot?.lastGaps.length, 10);
		assert.equal(snapshot?.lastGaps[0]?.length, 512);
		assert.equal(snapshot?.truncated, true);
		assert.equal(snapshot?.lastVerification?.truncated, true);
		assert.ok(JSON.stringify(snapshot).length < 16_000);
		assert.equal(f.lastGoal()?.objective, objective);
		assert.equal(f.lastGoal()?.lastGaps?.length, 10);
		assert.equal(f.lastGoal()?.lastGaps?.[0]?.length, 512);
	});

	test("success and blocked records carry model and current gaps; completion clears stale gaps", async () => {
		const f = fixture([
			notDone(["missing docs"]),
			{ achieved: true, gaps: [], modelFixable: true, model: "test/physical" },
		]);
		await f.setGoal("code and docs");
		await f.settle();
		await f.settle();
		const latest = (await f.query()).goal?.lastVerification;
		assert.equal(latest?.outcome, "verified-achieved");
		assert.equal(latest?.round, 2);
		assert.equal(latest?.model, "test/physical");
		assert.ok(Number.isSafeInteger(latest?.durationMs));
		assert.deepEqual((await f.query()).goal?.lastGaps, []);
		const blocked = fixture([{ achieved: false, gaps: ["human decision"], modelFixable: false }]);
		await blocked.setGoal("finish report");
		await blocked.settle();
		assert.deepEqual((await blocked.query()).goal?.lastGaps, ["human decision"]);
	});

	test("all failure kinds stay unverified and visible without copying secrets", async () => {
		for (const kind of ["timeout", "process", "model", "output"] as const) {
			const error = new VerificationError(kind, "test/physical");
			error.message = "Bearer secret-token OPENAI_API_KEY=secret-key";
			const f = fixture([error]);
			await f.setGoal("refactor auth");
			await f.settle();
			assert.equal(f.lastGoal()?.status, "active");
			assert.equal(f.lastGoal()?.lastVerification?.outcome, "unverified");
			assert.equal(f.lastGoal()?.lastVerification?.failure?.kind, kind);
			assert.equal(f.lastGoal()?.lastVerification?.model, "test/physical");
			await f.cmd("status");
			assert.match(f.notifications.at(-1) ?? "", new RegExp(`unverified.*${kind}`));
			assert.doesNotMatch(JSON.stringify([f.entries, await f.query(), f.notifications]), /secret-token|secret-key/);
		}
		const f = fixture([new Error("raw credentials")]);
		await f.setGoal("refactor auth");
		await f.settle();
		assert.equal(f.lastGoal()?.lastVerification?.failure?.kind, "process");
		assert.doesNotMatch(JSON.stringify(f.entries), /raw credentials/);
	});

	test("old sessions survive; latest summary restores independently of external references", async () => {
		const f = fixture([new VerificationError("output")]);
		await f.setGoal("document API");
		await f.settle();
		const stored = structuredClone(f.lastGoal());
		const restored = fixture([], { entries: [{ customType: "pi-quest", data: stored }] });
		await restored.setGoal("status");
		assert.equal((await restored.query()).goal?.lastVerification?.failure?.kind, "output");
		assert.equal((await restored.query()).goal?.status, "user_paused");
		for (const lastVerification of [undefined, { outcome: "bad" }, { ...stored?.lastVerification, round: -1 }]) {
			const legacy = fixture([], { entries: [{ customType: "pi-quest", data: { ...stored, lastVerification } }] });
			await legacy.setGoal("status");
			assert.equal((await legacy.query()).goal?.objective, "document API");
			assert.equal((await legacy.query()).goal?.lastVerification, undefined);
			assert.equal(legacy.sent.length, 0);
		}
	});

	test("restored verification is bounded, sanitizes failures, and follows only the selected branch", async () => {
		const f = fixture([notDone()]);
		await f.setGoal("current branch");
		await f.settle();
		const current = structuredClone(f.lastGoal());
		assert.ok(current);
		current.lastVerification = {
			outcome: "unverified",
			round: 1,
			durationMs: 5,
			model: "x".repeat(300),
			gaps: ["g".repeat(2000)],
			truncated: false,
			failure: { kind: "model", reason: "secret-stored-error" },
		};
		const restored = fixture([], {
			entries: [{ customType: "pi-quest", data: { ...current, objective: "other branch" } }],
			branchEntries: [{ customType: "pi-quest", data: current }],
		});
		await restored.setGoal("status");
		const snapshot = (await restored.query()).goal;
		assert.equal(snapshot?.objective, "current branch");
		assert.equal(snapshot?.lastVerification?.model?.length, 200);
		assert.equal(snapshot?.lastVerification?.gaps[0]?.length, 512);
		assert.equal(snapshot?.lastVerification?.truncated, true);
		assert.doesNotMatch(JSON.stringify([snapshot, restored.entries, restored.notifications]), /secret-stored-error/);
	});
});

for (const codemode of [false, true]) {
	test(`default verifier follows physical model with codemode ${codemode ? "opt-in" : "off"}`, async () => {
		const { pi, handlers, commands } = createPi();
		pi.registerFlag = (name, options) => {
			assert.equal(name, "quest-verifier-codemode");
			assert.equal(options.default, false);
		};
		pi.getFlag = (name) => {
			assert.equal(name, "quest-verifier-codemode");
			return codemode;
		};
		let spawned = false;
		pi.exec = async (command, args) => {
			if (command === "git") return { stdout: "abc123", stderr: "", code: 0, killed: false };
			spawned = true;
			assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-6.1-sol");
			assert.equal(args[args.indexOf("--thinking") + 1], "high");
			assert.equal(args.includes("-e"), codemode);
			assert.equal(args[args.indexOf("--tools") + 1], `read,grep,find,ls,bash${codemode ? ",codemode" : ""}`);
			if (codemode) assert.match(args[args.indexOf("-e") + 1] ?? "", /verifier-codemode\.ts$/);
			return {
				stdout: JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: '{"achieved": true, "gaps": []}' }],
						stopReason: "stop",
					},
				}),
				stderr: "",
				code: 0,
				killed: false,
			};
		};
		quest(pi);
		const ctx = {
			cwd: "/tmp/quest-test",
			model: { api: "pi-virtual", provider: "router", id: "auto" },
			thinkingLevel: "low",
			ui: { setStatus: () => {}, notify: () => {} },
			hasPendingMessages: () => false,
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						message: {
							role: "assistant",
							provider: "openai",
							model: "gpt-6.1-sol",
							thinkingLevel: "high",
							stopReason: "stop",
						},
					},
				],
			},
		};
		await commands.get("goal")?.("refactor auth", ctx as never);
		for (const handler of handlers.get("agent_before_settle") ?? []) {
			await handler(
				{ entries: [], continue: false, context: { pendingMessages: [] }, outcome: "completed" } as never,
				ctx as never,
			);
		}
		assert.equal(spawned, true);
	});
}

describe("loop", () => {
	test("setting a goal kicks off work immediately", async () => {
		const f = fixture([]);
		await f.setGoal("refactor auth");
		assert.equal(f.sent.length, 1);
		assert.match(f.sent[0]?.content ?? "", /Objective: refactor auth/);
		assert.equal(f.lastGoal()?.status, "active");
	});

	test("agent_before_settle requests a native continuation", async () => {
		const f = fixture([notDone()]);
		await f.setGoal("refactor auth");
		const result = await f.settle();
		assert.equal(f.sent.length, 2);
		assert.match(f.sent[1]?.content ?? "", /Continue working/);
		assert.equal(result?.continue, true);
		assert.equal(result?.entries?.[0]?.type, "custom_message");
	});

	test("achieved verdict completes the goal and stops the loop", async () => {
		const f = fixture([{ achieved: true, gaps: [], modelFixable: true }]);
		await f.setGoal("refactor auth");
		await f.settle();
		assert.equal(f.lastGoal()?.status, "complete");
		assert.equal(f.sent.length, 1); // kickoff only
		await f.settle();
		assert.equal(f.sent.length, 1);
	});

	test("verifier gaps are inlined into the next continuation", async () => {
		const f = fixture([notDone(["tests fail", "no error handling"])]);
		await f.setGoal("refactor auth");
		await f.settle();
		assert.match(f.sent[1]?.content ?? "", /tests fail/);
		assert.match(f.sent[1]?.content ?? "", /no error handling/);
	});

	test("verifier failure is fail-open: loop keeps going", async () => {
		const f = fixture([new Error("spawn failed"), notDone()]);
		await f.setGoal("refactor auth");
		await f.settle();
		assert.equal(f.lastGoal()?.status, "active");
		assert.equal(f.sent.length, 2);
	});

	test("agent_settled is notification-only; existing boundary drafts survive", async () => {
		const f = fixture([notDone()]);
		await f.setGoal("refactor auth");
		await f.fire("agent_settled");
		assert.equal(f.sent.length, 1);
		const draft = { type: "custom" as const, customType: "other-plugin", data: 1 };
		const result = await f.settle({ entries: [draft] });
		assert.deepEqual(result?.entries?.[0], draft);
		assert.equal(result?.continue, true);
	});

	test("another extension's continuation does not spend goal budget", async () => {
		const f = fixture([notDone()]);
		await f.setGoal("refactor auth");
		assert.equal(await f.settle({ continue: true }), undefined);
		assert.equal(f.lastGoal()?.round, 0);
		assert.equal(f.lastGoal()?.autoTurns, 0);
	});

	test("failed or aborted runs pause without verifying or continuing", async () => {
		for (const outcome of ["error", "aborted"] as const) {
			const f = fixture([{ achieved: true, gaps: [], modelFixable: true }]);
			await f.setGoal("refactor auth");
			await f.settle({ outcome });
			assert.equal(f.lastGoal()?.status, "user_paused");
			assert.equal(f.sent.length, 1);
		}
	});
});

describe("stall detection", () => {
	test("identical gap fingerprints twice → no_progress_paused", async () => {
		const f = fixture([notDone(["tests fail"]), notDone(["tests fail"])]);
		await f.setGoal("refactor auth");
		await f.settle();
		assert.equal(f.lastGoal()?.status, "active");
		await f.settle();
		assert.equal(f.lastGoal()?.status, "no_progress_paused");
		assert.ok(f.notifications.some((text) => text.includes("no progress paused")));
		assert.ok(!f.notifications.some((text) => text.includes("progress_paused")));
		await f.settle();
		assert.equal(f.sent.length, 2); // kickoff + one continuation, then stopped
	});

	test("whack-a-mole (different gaps) does not stall-pause", async () => {
		const f = fixture([notDone(["gap a"]), notDone(["gap b"]), notDone(["gap c"])]);
		await f.setGoal("refactor auth");
		for (let i = 0; i < 3; i++) await f.settle();
		assert.equal(f.lastGoal()?.status, "active");
	});

	test("normalization: whitespace/case/reordering still counts as identical", async () => {
		const f = fixture([notDone(["Tests  fail", "No handling"]), notDone(["no handling", "tests fail"])]);
		await f.setGoal("refactor auth");
		await f.settle();
		await f.settle();
		assert.equal(f.lastGoal()?.status, "no_progress_paused");
	});

	test("duplicate gaps do not hide a stall; resume starts a fresh streak", async () => {
		const f = fixture([notDone(["tests fail", "tests fail"]), notDone(["tests fail"])]);
		await f.setGoal("refactor auth");
		await f.settle();
		await f.settle();
		assert.equal(f.lastGoal()?.status, "no_progress_paused");
		await f.cmd("resume");
		await f.settle();
		assert.equal(f.lastGoal()?.status, "active");
		assert.equal(f.lastGoal()?.stallCount, 1);
	});
});

describe("caps and exits", () => {
	test("non-model-fixable verdict blocks the goal", async () => {
		const f = fixture([
			{ achieved: false, gaps: ["needs prod creds"], modelFixable: false, blocker: "needs prod creds" },
		]);
		await f.setGoal("deploy to prod");
		await f.settle();
		assert.equal(f.lastGoal()?.status, "blocked");
	});

	test("max-turns cap pauses with a wrap-up turn", async () => {
		const f = fixture([notDone()]);
		await f.setGoal("refactor auth --max-turns 2");
		await f.settle(); // auto 1/2
		await f.settle(); // auto 2/2
		assert.equal(f.lastGoal()?.status, "active");
		await f.settle(); // cap reached
		assert.equal(f.lastGoal()?.status, "budget_paused");
		const last = f.sent.at(-1);
		assert.match(last?.content ?? "", /Auto-paused after 2 continuations/);
	});

	test("pending user messages block continuation", async () => {
		const f = fixture([notDone()], { pending: true });
		await f.setGoal("refactor auth");
		f.sent.length = 0;
		await f.settle();
		assert.equal(f.sent.length, 0);
	});
});

describe("user control", () => {
	test("typing suspends the loop; resume re-arms it", async () => {
		const f = fixture([notDone()]);
		await f.setGoal("refactor auth");
		await f.userTypes();
		await f.settle();
		assert.equal(f.sent.length, 1); // kickoff only
		assert.match(f.statuses.at(-1) ?? "", /typing-suspended/);
		await f.cmd("resume");
		assert.equal(f.lastGoal()?.status, "active");
		assert.equal(f.lastGoal()?.suspended, false);
		assert.equal(f.sent.length, 2); // resume sends a continuation
	});

	test("pause stops; resume continues", async () => {
		const f = fixture([notDone()]);
		await f.setGoal("refactor auth");
		await f.cmd("pause");
		assert.equal(f.lastGoal()?.status, "user_paused");
		await f.settle();
		assert.equal(f.sent.length, 1);
		await f.cmd("resume");
		await f.settle();
		assert.equal(f.sent.length, 3);
	});

	test("our own [goal messages never suspend the loop", async () => {
		const f = fixture([notDone()]);
		await f.setGoal("refactor auth");
		await f.ownMessage();
		await f.settle();
		assert.equal(f.lastGoal()?.suspended, false);
		assert.equal(f.sent.length, 2); // continued normally
	});

	test("clear drops the goal", async () => {
		const f = fixture([notDone()]);
		await f.setGoal("refactor auth");
		await f.cmd("clear");
		assert.equal(f.lastGoal()?.status, "cleared");
		assert.equal(f.statuses.at(-1), undefined);
		await f.settle();
		assert.equal(f.sent.length, 1);
	});

	test("Esc abort observed at settlement pauses without rearming", async () => {
		const f = fixture([]);
		await f.setGoal("refactor auth");
		await f.fire("agent_settled", { aborted: true });
		assert.equal(f.lastGoal()?.status, "user_paused");
		assert.equal(f.sent.length, 1);
	});

	test("pause, clear, input, tree navigation, and shutdown cancel verification", async () => {
		for (const action of ["pause", "clear", "input", "session_tree", "session_shutdown"]) {
			let started!: () => void;
			const ready = new Promise<void>((resolve) => {
				started = resolve;
			});
			let signal: AbortSignal | undefined;
			const f = fixture([], {
				verifier: async (_objective, _round, activeSignal) => {
					signal = activeSignal;
					started();
					await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
					return { achieved: true, gaps: [], modelFixable: true };
				},
			});
			await f.setGoal("refactor auth");
			const settling = f.settle();
			await ready;
			if (action === "pause" || action === "clear") await f.cmd(action);
			else if (action === "input") await f.userTypes();
			else await f.fire(action);
			assert.equal(signal?.aborted, true);
			assert.equal(await settling, undefined);
			assert.equal(f.sent.length, 1);
			assert.notEqual(f.lastGoal()?.status, "complete");
			assert.equal((await f.query()).goal?.lastVerification, undefined);
		}
	});

	test("turn cancellation is not treated as verifier failure", async () => {
		const controller = new AbortController();
		const f = fixture([], {
			signal: controller.signal,
			verifier: async () => {
				controller.abort();
				throw new Error("aborted");
			},
		});
		await f.setGoal("refactor auth");
		await f.settle();
		assert.equal(f.lastGoal()?.status, "user_paused");
		assert.equal(f.lastGoal()?.autoTurns, 0);
		assert.equal(f.lastGoal()?.lastVerification, undefined);
	});

	test("replacing a goal releases the old in-flight guard", async () => {
		let resolveOld!: (verdict: GoalVerdict) => void;
		const old = new Promise<GoalVerdict>((resolve) => {
			resolveOld = resolve;
		});
		const f = fixture([], { verifier: async (objective) => (objective === "old" ? old : notDone()) });
		await f.setGoal("old");
		const settling = f.settle();
		await f.cmd("new");
		assert.equal((await f.settle())?.continue, true);
		const latest = structuredClone(f.lastGoal()?.lastVerification);
		resolveOld({ achieved: true, gaps: [], modelFixable: true });
		assert.equal(await settling, undefined);
		assert.equal(f.lastGoal()?.objective, "new");
		assert.equal(f.lastGoal()?.status, "active");
		assert.deepEqual(f.lastGoal()?.lastVerification, latest);
	});

	test("clear during baseline capture cannot resurrect an unfinished goal command", async () => {
		let resolveExec!: (result: Awaited<ReturnType<ExtensionAPI["exec"]>>) => void;
		const f = fixture([], {
			exec: () =>
				new Promise((resolve) => {
					resolveExec = resolve;
				}),
		});
		const setting = f.setGoal("refactor auth");
		await Promise.resolve();
		await Promise.resolve();
		await f.cmd("clear");
		resolveExec({ stdout: "abc123", stderr: "", code: 0, killed: false });
		await setting;
		assert.equal(f.sent.length, 0);
		assert.equal(f.lastGoal()?.status, "cleared");
	});
});

describe("goal arguments", () => {
	test("invalid budgets never silently fall back or parse partially", async () => {
		for (const value of [
			"",
			"0",
			"-2",
			"abc",
			"2.5",
			"2x",
			"9007199254740991",
			"9007199254740992",
			"1001",
			"1 --max-turns 2",
		]) {
			const f = fixture([]);
			await f.setGoal(`refactor auth --max-turns ${value}`);
			assert.equal(f.lastGoal(), undefined, value);
			assert.equal(f.sent.length, 0, value);
		}
	});

	test("equals form is supported and stripped from objective", async () => {
		const f = fixture([]);
		await f.setGoal("--max-turns=3 refactor auth");
		assert.equal(f.lastGoal()?.maxTurns, 3);
		assert.equal(f.lastGoal()?.objective, "refactor auth");
	});

	test("the sanity cap is inclusive at its boundary", async () => {
		const atCap = fixture([]);
		await atCap.setGoal("refactor auth --max-turns 1000");
		assert.equal(atCap.lastGoal()?.maxTurns, 1000);
		const overCap = fixture([]);
		await overCap.setGoal("refactor auth --max-turns 1001");
		assert.equal(overCap.lastGoal(), undefined);
	});

	test("objectives beginning with command names are not swallowed", async () => {
		const f = fixture([]);
		await f.setGoal("clear obsolete caches");
		assert.equal(f.lastGoal()?.objective, "clear obsolete caches");
		assert.equal(f.sent.length, 1);
		assert.equal(f.lastGoal()?.lastVerification, undefined);
	});
});

describe("persistence discipline", () => {
	test("restored active goal comes back user_paused, never self-driving", async () => {
		const stored: GoalState = {
			objective: "refactor auth",
			status: "active",
			round: 3,
			autoTurns: 2,
			maxTurns: 20,
			suspended: false,
			cwd: "/tmp/quest-test",
			stallCount: 0,
		};
		const f = fixture([], { entries: [{ customType: "pi-quest", data: stored }], startReason: "resume" });
		await f.setGoal("status"); // session_start fires inside setGoal
		assert.equal(f.lastGoal()?.status, "user_paused");
		await f.settle();
		assert.equal(f.sent.length, 0); // paused goal never continues
	});

	test("invalid persisted status is paused instead of self-driving", async () => {
		const stored = {
			objective: "refactor auth",
			status: "future_status",
			round: 3,
			autoTurns: 2,
			maxTurns: 20,
			suspended: false,
			cwd: "/tmp/quest-test",
			stallCount: 0,
		};
		const f = fixture([], { entries: [{ customType: "pi-quest", data: stored }], startReason: "resume" });
		await f.setGoal("status");
		assert.equal(f.lastGoal()?.status, "user_paused");
		assert.equal(f.sent.length, 0);
	});

	test("restores state from current branch, not another branch", async () => {
		const otherBranch: GoalState = {
			objective: "wrong branch",
			status: "active",
			round: 9,
			autoTurns: 9,
			maxTurns: 20,
			suspended: false,
			cwd: "/tmp/quest-test",
			stallCount: 0,
		};
		const currentBranch: GoalState = {
			objective: "current branch",
			status: "user_paused",
			round: 2,
			autoTurns: 1,
			maxTurns: 20,
			suspended: false,
			cwd: "/tmp/quest-test",
			stallCount: 0,
		};
		const f = fixture([], {
			entries: [{ customType: "pi-quest", data: otherBranch }],
			branchEntries: [{ customType: "pi-quest", data: currentBranch }],
		});
		await f.setGoal("status");
		assert.match(f.statuses.at(-1) ?? "", /user paused/);
		assert.match(f.sent.join("\n"), /^$/);
	});

	test("verdict finishing after pause cannot continue goal", async () => {
		let resolveVerdict!: (verdict: GoalVerdict) => void;
		let verifierStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			verifierStarted = resolve;
		});
		const verdict = new Promise<GoalVerdict>((resolve) => {
			resolveVerdict = resolve;
		});
		const f = fixture([], {
			verifier: async () => {
				verifierStarted();
				return verdict;
			},
		});
		await f.setGoal("refactor auth");
		const settling = f.settle();
		await started;
		await f.cmd("pause");
		resolveVerdict({ achieved: false, gaps: ["still broken"], modelFixable: true });
		await settling;
		assert.equal(f.lastGoal()?.status, "user_paused");
		assert.equal(f.sent.length, 1);
	});

	test("budget-paused goal cannot resume past cap", async () => {
		const f = fixture([notDone()]);
		await f.setGoal("refactor auth --max-turns 1");
		await f.settle();
		await f.settle();
		assert.equal(f.lastGoal()?.status, "budget_paused");
		await f.cmd("resume");
		assert.equal(f.lastGoal()?.status, "budget_paused");
	});

	test("/reload keeps an active goal active", async () => {
		const stored: GoalState = {
			objective: "refactor auth",
			status: "active",
			round: 3,
			autoTurns: 2,
			maxTurns: 20,
			suspended: false,
			cwd: "/tmp/quest-test",
			stallCount: 0,
		};
		const f = fixture([notDone()], { entries: [{ customType: "pi-quest", data: stored }], startReason: "reload" });
		await f.setGoal("status");
		await f.settle();
		assert.equal(f.sent.length, 1); // continued
	});

	test("tree navigation restores an active snapshot paused", async () => {
		const f = fixture([]);
		await f.setGoal("refactor auth");
		const stored = f.lastGoal();
		const restored = fixture([], {
			entries: [{ customType: "pi-quest", data: stored }],
			startReason: "reload",
		});
		await restored.setGoal("status");
		await restored.fire("session_tree");
		assert.equal(restored.lastGoal()?.status, "user_paused");
		assert.equal(restored.sent.length, 0);
	});

	test("a later tombstone beats older invalid snapshots without persisting repairs", async () => {
		const f = fixture([], {
			entries: [
				{
					customType: "pi-quest",
					data: {
						objective: "old",
						status: "invalid",
						round: 0,
						autoTurns: 0,
						maxTurns: 1,
						suspended: false,
						cwd: "/tmp",
						stallCount: 0,
					},
				},
				{ customType: "pi-quest", data: { status: "cleared" } },
			],
		});
		await f.setGoal("status");
		assert.equal(f.entries.length, 0);
		await f.settle();
		assert.equal(f.sent.length, 0);
	});

	test("oversized verifier text is bounded before it is persisted or notified", async () => {
		const f = fixture([{ achieved: false, gaps: ["needs creds"], modelFixable: false, blocker: "b".repeat(5000) }]);
		await f.setGoal("refactor auth");
		await f.settle();
		assert.equal(f.lastGoal()?.status, "blocked");
		assert.equal(f.lastGoal()?.pauseReason?.length, 512);
		assert.ok(f.notifications.every((text) => text.length < 700));
	});

	test("continuation and the persisted store both keep gaps bounded", async () => {
		const gaps = Array.from({ length: 25 }, (_, index) => `${index}-`.padEnd(2000, "x"));
		const f = fixture([notDone(gaps)]);
		await f.setGoal("refactor auth");
		await f.settle();
		assert.equal(f.lastGoal()?.lastGaps?.length, 10);
		assert.equal(f.lastGoal()?.lastGaps?.[0]?.length, 512);
		assert.ok((f.sent.at(-1)?.content.length ?? 0) < 6000, "continuation stays small");
	});

	test("a turn persists once, not twice", async () => {
		const f = fixture([notDone()]);
		await f.setGoal("refactor auth");
		const afterSet = f.entries.length;
		await f.fire("turn_start");
		assert.equal(f.entries.length, afterSet, "turn_start stays in memory");
		await f.fire("turn_end", { message: { role: "assistant", content: [] }, toolResults: [] });
		assert.equal(f.entries.length, afterSet + 1, "turn_end is the single write");
	});

	test("an unchanged worktree skips the skeptic and pauses as no progress", async () => {
		let verified = 0;
		const exec = ((_command: string, args: string[]) =>
			Promise.resolve(
				args.includes("rev-parse")
					? { stdout: "abc123\n", stderr: "", code: 0, killed: false }
					: { stdout: "", stderr: "", code: 0, killed: false },
			)) as ExtensionAPI["exec"];
		const f = fixture([], {
			exec,
			verifier: async () => {
				verified += 1;
				return notDone(["still broken"]);
			},
		});
		await f.setGoal("refactor auth");
		await f.settle();
		assert.equal(verified, 1);
		assert.equal(f.lastGoal()?.status, "active");
		assert.ok(f.lastGoal()?.lastVerifiedState, "fingerprint stored after a real verification");
		await f.settle();
		assert.equal(verified, 1, "identical worktree skips the skeptic");
		assert.equal(f.lastGoal()?.status, "no_progress_paused");
		assert.match(f.lastGoal()?.pauseReason ?? "", /unchanged/);
	});

	test("restored state drops unknown keys and unvalidated baselines", async () => {
		const stored = {
			objective: "refactor auth",
			status: "active",
			round: 2,
			autoTurns: 1,
			maxTurns: 20,
			suspended: false,
			cwd: "/tmp/quest-test",
			stallCount: 0,
			baselineCommit: "--ext-diff",
			injectedKey: "boom",
		};
		const f = fixture([], { entries: [{ customType: "pi-quest", data: stored }], startReason: "resume" });
		await f.setGoal("status");
		const restored = f.lastGoal();
		assert.equal(restored?.status, "user_paused");
		assert.equal(restored?.baselineCommit, undefined);
		assert.equal(restored ? "injectedKey" in restored : false, false);
	});

	test("restored state with an over-cap turn budget is rejected", async () => {
		const stored = {
			objective: "refactor auth",
			status: "user_paused",
			round: 2,
			autoTurns: 1,
			maxTurns: 100_000,
			suspended: false,
			cwd: "/tmp/quest-test",
			stallCount: 0,
		};
		const f = fixture([], { entries: [{ customType: "pi-quest", data: stored }] });
		await f.setGoal("status");
		assert.equal(f.lastGoal(), undefined);
	});
});
