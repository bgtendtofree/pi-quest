import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createQuest, type GoalState } from "../src/index.ts";
import { collectRecords } from "../src/records.ts";

test("native codemode preserves failed bash receipts and accounts nested model usage once", {
	timeout: 15_000,
}, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-quest-receipts-"));
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			cacheWarming: "off",
		});
		const nestedUsage = {
			input: 2,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5,
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
		};
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: cwd,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				(pi) => createQuest(pi, () => async () => ({ achieved: true, gaps: [], modelFixable: true })),
				createCodemodeExtension({ models: false }),
				(pi) =>
					pi.registerTool({
						name: "metered",
						label: "Metered",
						description: "Mock nested model usage",
						parameters: Type.Object({}),
						async execute() {
							return { content: [{ type: "text", text: "done" }], details: undefined, usage: nestedUsage };
						},
					}),
			],
		});
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({
			authPath: join(cwd, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(cwd, "models-store.json"),
			refreshOnCreate: false,
		});
		await modelRuntime.setRuntimeApiKey("openai", "test-only-no-network");
		const model = modelRuntime.getModel("openai", "gpt-6.1-sol");
		assert.ok(model);
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendCustomEntry("pi-quest", {
			objective: "inspect receipts",
			status: "active",
			round: 0,
			autoTurns: 0,
			maxTurns: 1,
			suspended: false,
			cwd,
			stallCount: 0,
		});
		({ session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			modelRuntime,
			model,
			resourceLoader,
			settingsManager,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "reload" },
			tools: ["codemode", "bash", "metered"],
		}));
		await session.bindExtensions({ mode: "json" });
		let requests = 0;
		session.agent.streamFunction = async () => {
			requests += 1;
			const message = {
				role: "assistant" as const,
				content:
					requests === 1
						? [
								{
									type: "toolCall" as const,
									id: "script",
									name: "codemode",
									arguments: {
										code: 'const failed = await tools.bash({command: "printf receipt; exit 7"}); await tools.metered({}); return {claimed: "passed", exitCode: failed.exit_code};',
									},
								},
							]
						: [{ type: "text" as const, text: "all passed" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 10,
					output: 2,
					cacheRead: 3,
					cacheWrite: 1,
					totalTokens: 16,
					cost: { input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.01 },
				},
				stopReason: requests === 1 ? ("toolUse" as const) : ("stop" as const),
				timestamp: Date.now(),
			};
			return {
				async *[Symbol.asyncIterator]() {
					if (message.stopReason === "toolUse") yield { type: "done" as const, reason: "toolUse" as const, message };
					else yield { type: "done" as const, reason: "stop" as const, message };
				},
				result: async () => message,
			};
		};
		const lines: string[] = [];
		session.subscribe((event) => {
			if (
				[
					"tool_execution_start",
					"tool_execution_end",
					"message_end",
					"turn_end",
					"agent_end",
					"agent_settled",
				].includes(event.type)
			)
				lines.push(JSON.stringify(event));
		});
		await session.prompt("start", { source: "extension" });
		assert.equal(requests, 2);
		const records = collectRecords(lines.join("\n") + "\n");
		const bash = records.receipts.find((receipt) => receipt.tool === "bash");
		assert.equal(bash?.status, "error");
		assert.equal(bash?.exitCode, 7);
		assert.equal(bash?.outputTruncated, false);
		assert.equal(records.streamIncomplete, false);
		assert.equal(records.usage.totalTokens, 37);
		assert.equal(records.usage.nestedUsageReports, 1);
		assert.equal(records.usage.estimatedCostUSD, 0.05);
		const snapshot = sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "custom" && entry.customType === "pi-quest");
		const goal = (snapshot as { data: GoalState }).data;
		assert.equal(goal.accounting?.main.usage.totalTokens, 37);
		assert.equal(goal.accounting?.main.usage.nestedUsageReports, 1);
		assert.equal(goal.accounting?.main.usage.estimatedCostUSD, 0.05);
	} finally {
		session?.dispose();
		await rm(cwd, { recursive: true, force: true });
	}
});

for (const scenario of [
	{ achievedAfter: 3, status: "complete", requests: 3, mode: "json" as const },
	{ achievedAfter: 0, status: "budget_paused", requests: 4, mode: "json" as const },
	{ achievedAfter: 3, status: "complete", requests: 3, mode: "rpc" as const },
	{ achievedAfter: 0, status: "budget_paused", requests: 4, mode: "rpc" as const },
	{ achievedAfter: 0, status: "no_progress_paused", requests: 2, mode: "json" as const },
	{ achievedAfter: 0, status: "no_progress_paused", requests: 2, mode: "rpc" as const },
]) {
	test(`Pi 1.0.1 ${scenario.mode} settles once after ${scenario.status}, including wrap-up`, {
		timeout: 10_000,
	}, async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-quest-runtime-"));
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			const settingsManager = SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: false },
				cacheWarming: "off",
			});
			let verifications = 0;
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: cwd,
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [
					(pi) =>
						createQuest(pi, () => async () => {
							verifications += 1;
							return {
								achieved: verifications === scenario.achievedAfter,
								gaps: scenario.status === "no_progress_paused" ? ["same gap"] : [],
								modelFixable: true,
							};
						}),
				],
			});
			await resourceLoader.reload();
			const modelRuntime = await ModelRuntime.create({
				authPath: join(cwd, "auth.json"),
				modelsPath: null,
				modelsStorePath: join(cwd, "models-store.json"),
				refreshOnCreate: false,
			});
			await modelRuntime.setRuntimeApiKey("openai", "test-only-no-network");
			const model = modelRuntime.getModel("openai", "gpt-6.1-sol");
			assert.ok(model);
			const sessionManager = SessionManager.inMemory(cwd);
			sessionManager.appendCustomEntry("pi-quest", {
				objective: "verify native continuation",
				status: "active",
				round: 0,
				autoTurns: 0,
				maxTurns: 2,
				suspended: false,
				cwd,
				stallCount: 0,
			});
			({ session } = await createAgentSession({
				cwd,
				agentDir: cwd,
				modelRuntime,
				model,
				resourceLoader,
				settingsManager,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "reload" },
				noTools: "all",
			}));
			await session.bindExtensions({ mode: scenario.mode });
			let requests = 0;
			session.agent.streamFunction = async (_model, context) => {
				requests += 1;
				if (requests > 1) {
					assert.ok(
						context.messages.some(
							(message) => message.role === "user" && JSON.stringify(message.content).includes("Continue working"),
						),
					);
				}
				const message = {
					role: "assistant" as const,
					content: [{ type: "text" as const, text: `round ${requests}` }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop" as const,
					timestamp: Date.now(),
				};
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "done" as const, reason: "stop" as const, message };
					},
					result: async () => message,
				};
			};
			let settlements = 0;
			session.subscribe((event) => {
				if (event.type === "agent_settled") {
					settlements += 1;
					assert.equal(
						verifications,
						scenario.status === "no_progress_paused" ? 2 : 3,
						"settled must not precede goal completion",
					);
				}
			});
			await session.prompt("start", { source: "extension" });
			assert.equal(requests, scenario.requests);
			assert.equal(settlements, 1);
			const snapshot = sessionManager
				.getBranch()
				.findLast((entry) => entry.type === "custom" && entry.customType === "pi-quest");
			assert.equal((snapshot as { data: { status: string; autoTurns: number } }).data.status, scenario.status);
			assert.equal(
				(snapshot as { data: { autoTurns: number } }).data.autoTurns,
				scenario.status === "no_progress_paused" ? 1 : 2,
			);
			const accounting = (snapshot as { data: GoalState }).data.accounting;
			assert.equal(accounting?.main.runs, scenario.requests);
			assert.equal(accounting?.main.completedRuns, scenario.requests);
			assert.equal(accounting?.verifier.runs, verifications);
			assert.equal(accounting?.verifier.completedRuns, verifications);
			assert.equal(accounting?.verifier.unreportedRuns, verifications);
		} finally {
			session?.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});
}

for (const via of ["direct", "codemode"] as const) {
	test(`quest_get_goal is read-only through ${via} in Pi 1.0.1`, { timeout: 15_000 }, async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-quest-query-"));
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			const settingsManager = SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: false },
				cacheWarming: "off",
			});
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: cwd,
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [
					(pi) =>
						createQuest(pi, () => async () => {
							assert.fail("query must not resume a paused goal or verify it");
						}),
					...(via === "codemode" ? [createCodemodeExtension({ models: false })] : []),
				],
			});
			await resourceLoader.reload();
			const modelRuntime = await ModelRuntime.create({
				authPath: join(cwd, "auth.json"),
				modelsPath: null,
				modelsStorePath: join(cwd, "models-store.json"),
				refreshOnCreate: false,
			});
			await modelRuntime.setRuntimeApiKey("openai", "test-only-no-network");
			const model = modelRuntime.getModel("openai", "gpt-6.1-sol");
			assert.ok(model);
			const sessionManager = SessionManager.inMemory(cwd);
			const stored = {
				objective: "document API",
				status: "user_paused",
				round: 3,
				autoTurns: 2,
				maxTurns: 20,
				suspended: false,
				cwd,
				stallCount: 0,
			};
			sessionManager.appendCustomEntry("pi-quest", stored);
			({ session } = await createAgentSession({
				cwd,
				agentDir: cwd,
				modelRuntime,
				model,
				resourceLoader,
				settingsManager,
				sessionManager,
				tools: ["quest_get_goal", ...(via === "codemode" ? ["codemode"] : [])],
			}));
			await session.bindExtensions({ mode: "json" });
			let requests = 0;
			let nestedQueries = 0;
			let settlements = 0;
			session.subscribe((event) => {
				if (event.type === "agent_settled") settlements += 1;
				if (event.type === "tool_execution_start" && event.parentToolCallId && event.toolName === "quest_get_goal") {
					nestedQueries += 1;
				}
			});
			session.agent.streamFunction = async (_model, context) => {
				requests += 1;
				if (requests === 2) {
					const result = context.messages.at(-1);
					assert.equal(result?.role, "toolResult");
					assert.equal((result as { isError: boolean }).isError, false);
					assert.match(JSON.stringify(result), /document API/);
					assert.match(JSON.stringify(result), /remainingTurns/);
					assert.doesNotMatch(JSON.stringify((result as { content: unknown }).content), /tampered/);
				}
				const toolCall = {
					type: "toolCall" as const,
					id: "query",
					name: via === "direct" ? "quest_get_goal" : "codemode",
					arguments:
						via === "direct"
							? {}
							: {
									code: 'const first = await tools.quest_get_goal({}); first.goal.objective = "tampered"; return await tools.quest_get_goal({});',
								},
				};
				const message = {
					role: "assistant" as const,
					content: requests === 1 ? [toolCall] : [{ type: "text" as const, text: "query finished" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: requests === 1 ? ("toolUse" as const) : ("stop" as const),
					timestamp: Date.now(),
				};
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "done" as const, reason: message.stopReason, message };
					},
					result: async () => message,
				};
			};
			await session.prompt("inspect the goal", { source: "extension" });
			assert.equal(requests, 2);
			assert.equal(settlements, 1);
			assert.equal(nestedQueries, via === "codemode" ? 2 : 0);
			assert.deepEqual(
				sessionManager
					.getBranch()
					.filter((entry) => entry.type === "custom" && entry.customType === "pi-quest")
					.map((entry) => (entry as { data: unknown }).data),
				[stored],
			);
		} finally {
			session?.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});
}
