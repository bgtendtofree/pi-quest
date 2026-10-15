import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ExecFn } from "../src/verifier.ts";

export const verdictText = '```json\n{"achieved": false, "gaps": ["gap one"], "model_fixable": true}\n```';

interface FakeReply {
	text?: string;
	stopReason?: "stop" | "error";
	toolCall?: { name: string; arguments: Record<string, unknown> };
}

export type { FakeReply };

export interface FakeCall {
	apiKey: string | undefined;
	model: string;
	reasoning: string | undefined;
	text: string;
}

export interface Harness {
	dir: string;
	runtime: ModelRuntime;
	registry: ModelRegistry;
	model: NonNullable<ReturnType<ModelRegistry["find"]>>;
	calls: FakeCall[];
	/** Settle any provider stream that was left hanging (ignoreAbort mode). */
	release: () => void;
	dispose: () => void;
}

function modelConfig(id: string): ProviderModelConfig {
	return {
		id,
		name: `Fake ${id}`,
		api: "fake-api",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		contextWindow: 128_000,
		maxTokens: 4096,
	};
}

function assistantMessage(reply: FakeReply, index: number): unknown {
	const content: Array<Record<string, unknown>> = [];
	if (reply.text !== undefined) content.push({ type: "text", text: reply.text });
	if (reply.toolCall) {
		content.push({
			type: "toolCall",
			id: `call-${index}`,
			name: reply.toolCall.name,
			arguments: reply.toolCall.arguments,
		});
	}
	return {
		role: "assistant",
		content,
		api: "fake-api",
		provider: "fake",
		model: "fake-model",
		usage: {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: reply.stopReason ?? "stop",
		timestamp: 1,
	};
}

function finishedStream(message: unknown): unknown {
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "done", reason: (message as { stopReason: string }).stopReason, message };
		},
		result: async () => message,
	};
}

function stalledStream(waiter: Promise<void>, message: unknown): unknown {
	const iterator = {
		async next() {
			await waiter;
			return { done: true as const, value: undefined };
		},
	};
	return {
		[Symbol.asyncIterator]: () => iterator,
		result: () => waiter.then(() => message),
	};
}

/** Real ModelRegistry + fake provider: records the credential and context it sees. */
export async function makeHarness(options?: {
	reply?: (call: number) => FakeReply;
	apiKey?: string;
	ignoreAbort?: boolean;
	extraModels?: string[];
}): Promise<Harness> {
	const dir = mkdtempSync(join(tmpdir(), "pi-quest-host-"));
	const runtime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(dir, "models.json"),
		refreshOnCreate: false,
	});
	const calls: FakeCall[] = [];
	let releaseWaiter: () => void = () => {};
	const waiter = new Promise<void>((resolve) => {
		releaseWaiter = resolve;
	});
	runtime.registerProvider("fake", {
		name: "fake",
		baseUrl: "http://127.0.0.1:1",
		apiKey: options?.apiKey ?? "real-host-key",
		api: "fake-api",
		models: [modelConfig("fake-model"), ...(options?.extraModels ?? []).map(modelConfig)],
		streamSimple: (model, context, streamOptions) => {
			const index = calls.length + 1;
			calls.push({
				apiKey: streamOptions?.apiKey,
				model: `${model.provider}/${model.id}`,
				reasoning: streamOptions?.reasoning,
				text: JSON.stringify(context.messages),
			});
			const message = assistantMessage(options?.reply?.(index) ?? { text: verdictText }, index);
			return (options?.ignoreAbort ? stalledStream(waiter, message) : finishedStream(message)) as never;
		},
	});
	const registry = new ModelRegistry(runtime);
	const model = registry.find("fake", "fake-model");
	assert.ok(model, "fake model must resolve through the registry");
	return {
		dir,
		runtime,
		registry,
		model,
		calls,
		release: releaseWaiter,
		dispose: () => rmSync(dir, { recursive: true, force: true }),
	};
}

export function gitExec(tree: { diff?: string; status?: string; code?: number; killed?: boolean }): ExecFn {
	return async (command, args) => {
		if (command !== "git") throw new Error("unexpected exec");
		if (args.includes("rev-parse")) return { stdout: "abc123\n", stderr: "", code: 0, killed: false };
		if (args.includes("status")) return { stdout: tree.status ?? "", stderr: "", code: 0, killed: false };
		return { stdout: tree.diff ?? "", stderr: "", code: tree.code ?? 0, killed: tree.killed ?? false };
	};
}
