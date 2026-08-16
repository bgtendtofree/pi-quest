import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createQuest, type GoalState, type GoalVerdict, type GoalVerifier } from "../src/index.ts";

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
} {
	const handlers = new Map();
	const commands = new Map();
	const sent: Sent[] = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	const pi = {
		on(event: string, handler: (event: never, ctx: never) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name: string, def: { handler: (args: string, ctx: never) => Promise<void> }) {
			commands.set(name, def.handler);
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
	return { pi, handlers, commands, sent, entries };
}

interface Fixture {
	sent: Sent[];
	entries: Array<{ customType: string; data: unknown }>;
	statuses: string[];
	setGoal: (args: string) => Promise<void>;
	cmd: (args: string) => Promise<void>;
	settle: () => Promise<void>;
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
		verifier?: GoalVerifier;
	},
): Fixture {
	const { pi, handlers, commands, sent, entries } = createPi();
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
	const ctx = {
		cwd: "/tmp/quest-test",
		isIdle: () => true,
		hasPendingMessages: () => opts?.pending ?? false,
		ui: {
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			notify: () => {},
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

	const fire = async (event: string, payload: unknown) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload as never, ctx as never);
	};

	return {
		sent,
		entries,
		statuses,
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
		settle: () => fire("agent_settled", {}),
		userTypes: () => fire("input", { source: "interactive", text: "redirect" }),
		ownMessage: () => fire("input", { source: "extension", text: "[goal round 1] Objective: x" }),
		lastGoal: () => {
			const last = entries.filter((e) => e.customType === "pi-quest").at(-1);
			return last?.data as GoalState | undefined;
		},
	};
}

const notDone = (gaps: string[] = []): GoalVerdict => ({ achieved: false, gaps, modelFixable: true });

describe("loop", () => {
	test("setting a goal kicks off work immediately", async () => {
		const f = fixture([]);
		await f.setGoal("refactor auth");
		assert.equal(f.sent.length, 1);
		assert.match(f.sent[0]?.content ?? "", /Objective: refactor auth/);
		assert.equal(f.lastGoal()?.status, "active");
	});

	test("agent_settled continues an active goal with a followUp turn", async () => {
		const f = fixture([notDone()]);
		await f.setGoal("refactor auth");
		await f.settle();
		assert.equal(f.sent.length, 2);
		assert.match(f.sent[1]?.content ?? "", /Continue working/);
		assert.equal(f.sent[1]?.options?.deliverAs, "followUp");
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
});

describe("stall detection", () => {
	test("identical gap fingerprints twice → no_progress_paused", async () => {
		const f = fixture([notDone(["tests fail"]), notDone(["tests fail"])]);
		await f.setGoal("refactor auth");
		await f.settle();
		assert.equal(f.lastGoal()?.status, "active");
		await f.settle();
		assert.equal(f.lastGoal()?.status, "no_progress_paused");
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
});
