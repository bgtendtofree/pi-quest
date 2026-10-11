import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { collectRecords } from "../src/records.ts";
import { buildSkepticPrompt, parseVerdict } from "../src/verifier.ts";

const adapter = fileURLToPath(new URL("../src/verifier-codemode.ts", import.meta.url));
const allowlist = ["read", "grep", "find", "ls", "bash"];

async function child(codemode: boolean, mode: "json" | "rpc" = "json") {
	const cwd = await mkdtemp(join(tmpdir(), "pi-quest-child-"));
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
			additionalExtensionPaths: codemode ? [adapter] : [],
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(cwd, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(cwd, "models-store.json"),
			refreshOnCreate: false,
		});
		await modelRuntime.setRuntimeApiKey("openai", "test-only-no-network");
		const model = modelRuntime.getModel("openai", "gpt-6.1-sol");
		assert.ok(model);
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			modelRuntime,
			model,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			tools: [...allowlist, ...(codemode ? ["codemode"] : [])],
		});
		await session.bindExtensions({ mode });
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
		let requests = 0;
		function respond(
			content: Array<
				| { type: "text"; text: string }
				| {
						type: "toolCall";
						id: string;
						name: string;
						arguments: Record<string, unknown>;
				  }
			>,
		) {
			requests += 1;
			const message = {
				role: "assistant" as const,
				content,
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
				stopReason: content.some((part) => part.type === "toolCall") ? ("toolUse" as const) : ("stop" as const),
				timestamp: Date.now(),
			};
			return {
				async *[Symbol.asyncIterator]() {
					if (message.stopReason === "toolUse") yield { type: "done" as const, reason: "toolUse" as const, message };
					else yield { type: "done" as const, reason: "stop" as const, message };
				},
				result: async () => message,
			};
		}
		return {
			cwd,
			session,
			lines,
			respond,
			requests: () => requests,
			records: () => collectRecords(lines.join("\n") + "\n"),
			async close() {
				session.dispose();
				// Tests own spill files created by their scripts; production never deletes native logs.
				for (const receipt of collectRecords(lines.join("\n")).receipts) {
					if (receipt.fullOutputFile) await rm(join(tmpdir(), receipt.fullOutputFile), { force: true });
				}
				await rm(cwd, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await rm(cwd, { recursive: true, force: true });
		throw error;
	}
}

for (const scenario of ["docs-pass", "docs-gap", "checks-pass", "checks-fail", "missing-evidence", "script-fail"]) {
	test(`fixed verifier comparison: ${scenario}`, { timeout: 15_000 }, async (t) => {
		const results = [];
		for (const codemode of [false, true]) {
			const run = await child(codemode);
			try {
				await writeFile(join(run.cwd, "README.md"), "# API\n");
				await writeFile(
					join(run.cwd, "SOURCES.md"),
					scenario === "docs-gap" ? "sources pending\n" : "https://example.test/source\n",
				);
				const docs = scenario.startsWith("docs");
				const calls = docs
					? [
							{ name: "read", arguments: { path: "README.md" } },
							{ name: "read", arguments: { path: "SOURCES.md" } },
						]
					: [
							{ name: "bash", arguments: { command: "printf check-A" } },
							{
								name: "bash",
								arguments: {
									command: `printf check-B; exit ${scenario === "checks-fail" || scenario === "script-fail" ? 7 : 0}`,
								},
							},
						];
				let step = 0;
				run.session.agent.streamFunction = async (_model, context) => {
					const declared = new Map<string, string>();
					for (const message of context.messages) {
						if (message.role !== "system") continue;
						for (const tool of message.toolsRemoved ?? []) declared.delete(tool.name);
						for (const tool of message.toolsAdded ?? []) declared.set(tool.name, tool.description);
					}
					assert.deepEqual(
						[...declared.keys()].sort(),
						codemode ? ["codemode"] : [...allowlist].sort(),
						"opt-in must be code-only, not merely add another declared tool",
					);
					if (codemode) {
						for (const name of allowlist) assert.ok(declared.get("codemode")?.includes(name));
					}
					if (codemode && step++ === 0) {
						const work =
							scenario === "missing-evidence"
								? 'return {claimed: "passed"};'
								: `if (ALL_TOOLS.map(t => t.name).sort().join(",") !== ${JSON.stringify([...allowlist].sort().join(","))}) throw new Error("callable allowlist changed");
										const outputs = await Promise.allSettled([${calls
											.map((call) => `tools.${call.name}(${JSON.stringify(call.arguments)})`)
											.join(",")}]);
								text({outputs, modelsDisabled: typeof models === "undefined", tools: ALL_TOOLS.map(t => t.name)});
								${scenario === "script-fail" ? 'throw new Error("fixture script failed");' : ""}`;
						return run.respond([{ type: "toolCall", id: "batch", name: "codemode", arguments: { code: work } }]);
					}
					if (!codemode && scenario !== "missing-evidence" && step < calls.length) {
						const call = calls[step++];
						assert.ok(call);
						return run.respond([{ type: "toolCall", id: `check-${step}`, ...call }]);
					}
					const evidence = run.records();
					const actual = evidence.receipts.filter((receipt) => receipt.tool !== "codemode");
					const text = JSON.stringify(context.messages.filter((message) => message.role === "toolResult"));
					if (codemode && scenario !== "missing-evidence") {
						assert.match(text, /modelsDisabled\\?":true/);
						assert.doesNotMatch(text, /"name":"(?:edit|write)"/);
					}
					const achieved =
						actual.length === calls.length &&
						actual.every((receipt) => receipt.status === "ok") &&
						(!docs || text.includes("https://example.test/source"));
					return run.respond([
						{
							type: "text",
							text: JSON.stringify({
								achieved,
								gaps: achieved ? [] : ["requirement lacks successful evidence"],
								model_fixable: true,
							}),
						},
					]);
				};
				const started = performance.now();
				await run.session.prompt(
					buildSkepticPrompt(docs ? "Document API with a source" : "Check both artifacts", "", codemode),
				);
				const durationMs = performance.now() - started;
				const records = run.records();
				const verdict = parseVerdict(run.session.getLastAssistantText() ?? "");
				assert.equal(verdict?.achieved, scenario === "docs-pass" || scenario === "checks-pass");
				assert.equal(run.lines.filter((line) => JSON.parse(line).type === "agent_settled").length, 1);
				assert.equal(records.streamIncomplete, false);
				const actual = records.receipts.filter((receipt) => receipt.tool !== "codemode");
				if (codemode)
					assert.ok(
						actual.every((receipt) => receipt.parentRef),
						"nested identity must survive",
					);
				results.push({
					verdict,
					coverage: actual.map((receipt) => receipt.argsRef).sort(),
					records,
					durationMs,
					requests: run.requests(),
				});
			} finally {
				await run.close();
			}
		}
		assert.deepEqual(results[0]?.verdict, results[1]?.verdict);
		assert.deepEqual(results[0]?.coverage, results[1]?.coverage);
		if (scenario === "checks-fail") {
			for (const result of results)
				assert.ok(result.records.receipts.some((receipt) => receipt.exitCode === 7 && receipt.status === "error"));
		}
		t.diagnostic(
			`Scripted fixtures, NOT live-model savings: ${results
				.map(
					(result, i) =>
						`${i ? "codemode" : "direct"} ${result.durationMs.toFixed(1)}ms, ${result.requests} responses, ${result.records.usage.totalTokens} reported mock tokens`,
				)
				.join("; ")}`,
		);
	});
}

test("codemode cancellation stops nested bash and emits one settlement", { timeout: 15_000 }, async () => {
	const run = await child(true, "rpc");
	try {
		let started: (() => void) | undefined;
		const childStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		run.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === "bash" && event.parentToolCallId)
				setTimeout(() => started?.(), 100);
		});
		run.session.agent.streamFunction = async (_model, _context, options) => {
			options?.signal?.throwIfAborted();
			if (run.requests() > 0) return run.respond([{ type: "text", text: "stopped" }]);
			return run.respond([
				{
					type: "toolCall",
					id: "batch",
					name: "codemode",
					arguments: {
						code: '// @options: {"timeout_ms": 3000}\nawait tools.bash({command: "printf started; sleep 60", timeout: 2}); return "passed";',
					},
				},
			]);
		};
		const pending = run.session.prompt("check artifact");
		await childStarted;
		await run.session.abort();
		await pending;
		assert.equal(
			run.requests(),
			1,
			run.lines.filter((line) => JSON.parse(line).type === "tool_execution_end").join("\n"),
		);
		assert.equal(run.lines.filter((line) => JSON.parse(line).type === "agent_settled").length, 1);
		assert.ok(run.records().receipts.some((receipt) => receipt.tool === "bash" && receipt.status !== "ok"));
	} finally {
		await run.close();
	}
});

test("models.* disabled and native truncated-output file survives collection", { timeout: 15_000 }, async () => {
	const run = await child(true);
	try {
		let called = false;
		run.session.agent.streamFunction = async () => {
			if (!called) {
				called = true;
				return run.respond([
					{
						type: "toolCall",
						id: "spill",
						name: "codemode",
						arguments: {
							code: '// @options: {"max_output_tokens": 16}\nif (typeof models !== "undefined") throw new Error("paid models exposed"); return "X".repeat(2000);',
						},
					},
				]);
			}
			return run.respond([{ type: "text", text: "done" }]);
		};
		await run.session.prompt("inspect");
		const receipt = run.records().receipts.find((receipt) => receipt.tool === "codemode");
		assert.equal(receipt?.status, "ok");
		assert.equal(receipt?.outputTruncated, true);
		assert.match(receipt?.fullOutputFile ?? "", /^pi-codemode-[a-f0-9]{16}\.txt$/);
	} finally {
		await run.close();
	}
});
