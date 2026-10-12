import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const Count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Metrics = {
	inputTokens: Type.Optional(Count),
	outputTokens: Type.Optional(Count),
	cacheReadTokens: Type.Optional(Count),
	cacheWriteTokens: Type.Optional(Count),
	totalTokens: Type.Optional(Count),
	estimatedCostUSD: Type.Optional(Type.Number({ minimum: 0 })),
};
export const UsageSchema = Type.Object(
	{
		assistantResponses: Count,
		nestedUsageReports: Count,
		tokenReports: Count,
		costReports: Count,
		...Metrics,
	},
	{ additionalProperties: false },
);
export type UsageTotals = Static<typeof UsageSchema>;
const RunSchema = Type.Object(
	{
		runs: Count,
		completedRuns: Count,
		unreportedRuns: Count,
		durationMs: Type.Optional(Count),
		usage: UsageSchema,
	},
	{ additionalProperties: false },
);
export const AccountingSchema = Type.Object({ main: RunSchema, verifier: RunSchema }, { additionalProperties: false });
export type Accounting = Static<typeof AccountingSchema>;

const Ref = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const LOG_FILE_PATTERN = "^pi-(?:bash-[a-f0-9]{16}\\.log|codemode-[a-f0-9]{16}\\.txt)$";
const ReceiptSchema = Type.Object(
	{
		source: Type.Union([Type.Literal("tool_execution_start"), Type.Literal("tool_execution_end")]),
		tool: Type.Union([
			Type.Literal("read"),
			Type.Literal("grep"),
			Type.Literal("find"),
			Type.Literal("ls"),
			Type.Literal("bash"),
			Type.Literal("codemode"),
			Type.Literal("unknown"),
		]),
		callRef: Ref,
		parentRef: Type.Optional(Ref),
		argsRef: Type.Optional(Ref),
		outputRef: Type.Optional(Ref),
		status: Type.Union([
			Type.Literal("ok"),
			Type.Literal("error"),
			Type.Literal("unknown"),
			Type.Literal("unfinished"),
		]),
		exitCode: Type.Optional(Type.Integer()),
		durationMs: Type.Optional(Count),
		outputTruncated: Type.Optional(Type.Boolean()),
		/** Native Pi spill filename in os.tmpdir(); availability is unknown. */
		fullOutputFile: Type.Optional(Type.String({ pattern: LOG_FILE_PATTERN, maxLength: 64 })),
	},
	{ additionalProperties: false },
);
export const RecordsSchema = Type.Object(
	{
		toolCalls: Count,
		failedCalls: Count,
		omitted: Count,
		streamIncomplete: Type.Boolean(),
		receipts: Type.Array(ReceiptSchema, { maxItems: 20 }),
		usage: UsageSchema,
	},
	{ additionalProperties: false },
);
export type VerificationRecords = Static<typeof RecordsSchema>;

export function emptyUsage(): UsageTotals {
	return { assistantResponses: 0, nestedUsageReports: 0, tokenReports: 0, costReports: 0 };
}

export function newAccounting(): Accounting {
	return {
		main: { runs: 0, completedRuns: 0, unreportedRuns: 0, usage: emptyUsage() },
		verifier: { runs: 0, completedRuns: 0, unreportedRuns: 0, usage: emptyUsage() },
	};
}

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Only final messages, never streaming deltas or duplicate tool-end usage. */
export function recordUsage(totals: UsageTotals, message: unknown): void {
	const raw = object(message);
	if (raw.role === "assistant") totals.assistantResponses += 1;
	else if (raw.role === "toolResult" && raw.usage) totals.nestedUsageReports += 1;
	else return;
	const usage = object(raw.usage);
	const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
	if (
		fields.every((key) => Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0) &&
		(usage.totalTokens as number) > 0
	) {
		totals.tokenReports += 1;
		for (const [key, source] of [
			["inputTokens", "input"],
			["outputTokens", "output"],
			["cacheReadTokens", "cacheRead"],
			["cacheWriteTokens", "cacheWrite"],
			["totalTokens", "totalTokens"],
		] as const) {
			totals[key] = (totals[key] ?? 0) + (usage[source] as number);
		}
	}
	const cost = object(usage.cost).total;
	// Pi initializes usage/cost to zero, also used by unpriced models. Zero
	// cannot distinguish "free" from "not reported"; conservatively unknown.
	if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) {
		totals.costReports += 1;
		totals.estimatedCostUSD = (totals.estimatedCostUSD ?? 0) + cost;
	}
}

export function finishRun(run: Accounting["main"], durationMs: number, usage: UsageTotals): void {
	run.completedRuns += 1;
	if (usage.assistantResponses === 0) run.unreportedRuns += 1;
	run.durationMs = (run.durationMs ?? 0) + Math.max(0, Math.round(durationMs));
	for (const key of Object.keys(UsageSchema.properties) as Array<keyof UsageTotals>) {
		if (usage[key] !== undefined) run.usage[key] = (run.usage[key] ?? 0) + (usage[key] as number);
	}
}

export function restoreAccounting(value: unknown): Accounting | undefined {
	if (!Value.Check(AccountingSchema, value)) return;
	if (
		[value.main, value.verifier].some(
			(run) =>
				run.completedRuns > run.runs ||
				run.unreportedRuns > run.completedRuns ||
				run.usage.tokenReports > run.usage.assistantResponses + run.usage.nestedUsageReports ||
				run.usage.costReports > run.usage.assistantResponses + run.usage.nestedUsageReports,
		)
	)
		return;
	return structuredClone(value);
}

export function restoreRecords(value: unknown): VerificationRecords | undefined {
	if (!Value.Check(RecordsSchema, value)) return;
	if (value.toolCalls !== value.omitted + value.receipts.length) return;
	const retainedFailures = value.receipts.filter((receipt) => receipt.status === "error").length;
	if (value.failedCalls < retainedFailures || value.failedCalls > retainedFailures + value.omitted) return;
	// Mirror restoreAccounting: usage that claims more reports than observed
	// responses would poison the persisted accounting and be dropped on restore.
	const sources = value.usage.assistantResponses + value.usage.nestedUsageReports;
	if (value.usage.tokenReports > sources || value.usage.costReports > sources) return;
	return structuredClone(value);
}

function ref(value: unknown): string {
	return `sha256:${createHash("sha256")
		.update(JSON.stringify(value) ?? "")
		.digest("hex")}`;
}

/**
 * Receipts come from actual CLI events, not assistant prose. Hash identifiers,
 * args and output: no new raw command/output log, credential leak, or cleanup
 * subsystem. Only validated native spill basenames are retained, never arbitrary
 * paths. Native Pi logs remain owned by Pi and aren't assumed readable.
 */
export function collectRecords(stdout: string): VerificationRecords {
	const usage = emptyUsage();
	const calls = new Map<string, Static<typeof ReceiptSchema>>();
	const ended = new Set<string>();
	let settled = false;
	let malformed = false;
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		let event: Record<string, unknown>;
		try {
			event = object(JSON.parse(line));
		} catch {
			malformed = true;
			continue;
		}
		if (event.type === "agent_settled") settled = true;
		if (event.type === "message_end" && !event.parentToolCallId) recordUsage(usage, event.message);
		if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") continue;
		if (typeof event.toolCallId !== "string" || ended.has(event.toolCallId)) continue;
		const id = event.toolCallId;
		const prior = calls.get(id);
		const tool = ["read", "grep", "find", "ls", "bash", "codemode"].includes(event.toolName as string)
			? (event.toolName as Static<typeof ReceiptSchema>["tool"])
			: "unknown";
		const receipt: Static<typeof ReceiptSchema> = {
			source: event.type,
			tool,
			callRef: ref(id),
			...(typeof event.parentToolCallId === "string"
				? { parentRef: ref(event.parentToolCallId) }
				: prior?.parentRef
					? { parentRef: prior.parentRef }
					: {}),
			...(event.args !== undefined ? { argsRef: ref(event.args) } : prior?.argsRef ? { argsRef: prior.argsRef } : {}),
			status: "unfinished",
		};
		if (event.type === "tool_execution_end") {
			ended.add(id);
			const result = object(event.result);
			const data = object(result.structuredContent);
			const details = object(result.details);
			const exitCode = Number.isSafeInteger(data.exit_code) ? (data.exit_code as number) : undefined;
			receipt.status =
				event.isError === true || result.isError === true || (exitCode !== undefined && exitCode !== 0)
					? "error"
					: event.isError === false && Array.isArray(result.content) && (tool !== "bash" || exitCode === 0)
						? "ok"
						: "unknown";
			if (exitCode !== undefined) receipt.exitCode = exitCode;
			// Pi 1.1.0 reports the tool's own measured execution time on the end
			// event; it is absent only when the tool did not run.
			const duration = event.durationMs;
			if (
				typeof duration === "number" &&
				Number.isFinite(duration) &&
				duration >= 0 &&
				Number.isSafeInteger(Math.round(duration))
			)
				receipt.durationMs = Math.round(duration);
			if (typeof data.truncated === "boolean") receipt.outputTruncated = data.truncated;
			if (object(details.truncation).truncated === true) receipt.outputTruncated = true;
			const logPath = data.full_output_path ?? details.fullOutputPath;
			if (
				typeof logPath === "string" &&
				dirname(logPath) === tmpdir() &&
				new RegExp(LOG_FILE_PATTERN).test(basename(logPath))
			) {
				receipt.fullOutputFile = basename(logPath);
				if (tool === "codemode") receipt.outputTruncated = true;
			}
			if (typeof data.output === "string") receipt.outputRef = ref(data.output);
			else if (Array.isArray(result.content)) receipt.outputRef = ref(result.content);
		}
		calls.set(id, receipt);
	}
	const receipts = [...calls.values()].slice(-20);
	return {
		toolCalls: calls.size,
		failedCalls: [...calls.values()].filter((call) => call.status === "error").length,
		omitted: calls.size - receipts.length,
		streamIncomplete: !settled || malformed || [...calls.values()].some((call) => call.status === "unfinished"),
		receipts,
		usage,
	};
}

export function accountingText(accounting: Accounting): string {
	return (["main", "verifier"] as const)
		.map((name) => {
			const run = accounting[name];
			const usage = run.usage;
			const sources = usage.assistantResponses + usage.nestedUsageReports;
			const partial = (reports: number) =>
				reports < sources || run.completedRuns < run.runs || run.unreportedRuns > 0 ? " (partial)" : "";
			return (
				`${name}: ${run.completedRuns}/${run.runs} runs | ${run.durationMs ?? "unknown"}ms` +
				` | tokens ${usage.totalTokens ?? "unknown"}${partial(usage.tokenReports)}` +
				` | estimated USD ${usage.estimatedCostUSD ?? "unknown"}${partial(usage.costReports)}`
			);
		})
		.join("\n");
}
