import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	accountingText,
	collectRecords,
	emptyUsage,
	finishRun,
	newAccounting,
	recordUsage,
	restoreAccounting,
	restoreRecords,
} from "../src/records.ts";

const jsonl = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const usage = {
	input: 10,
	output: 2,
	cacheRead: 3,
	cacheWrite: 1,
	totalTokens: 16,
	cost: { total: 0.01 },
};

test("nested codemode records keep parent identity and safe native log references, never arbitrary paths", () => {
	const nativeFile = "pi-bash-0123456789abcdef.log";
	const records = collectRecords(
		jsonl([
			{ type: "tool_execution_start", toolCallId: "parent", toolName: "codemode", args: { code: "SECRET" } },
			{ type: "tool_execution_start", toolCallId: "child", toolName: "bash", parentToolCallId: "parent" },
			{
				type: "tool_execution_end",
				toolCallId: "child",
				toolName: "bash",
				isError: true,
				result: {
					content: [],
					structuredContent: { exit_code: 1, truncated: true, full_output_path: join(tmpdir(), nativeFile) },
				},
			},
			{
				type: "tool_execution_end",
				toolCallId: "parent",
				toolName: "codemode",
				isError: false,
				result: {
					content: [],
					details: { fullOutputPath: join(tmpdir(), "pi-codemode-0123456789abcdef.txt") },
				},
			},
			{
				type: "tool_execution_end",
				toolCallId: "bad-path",
				toolName: "bash",
				isError: false,
				result: {
					content: [],
					details: { fullOutputPath: "/SECRET/path.log" },
				},
			},
			{ type: "agent_settled" },
		]),
	);
	assert.equal(records.receipts[0]?.tool, "codemode");
	assert.equal(records.receipts[0]?.outputTruncated, true);
	assert.equal(records.receipts[1]?.parentRef, records.receipts[0]?.callRef);
	assert.equal(
		records.receipts[1]?.fullOutputFile,
		nativeFile,
		"path needn't exist; no log reads or completion inference",
	);
	assert.equal(records.receipts[2]?.fullOutputFile, undefined);
	assert.equal(records.failedCalls, 1);
	assert.doesNotMatch(JSON.stringify(records), /SECRET/);
	assert.deepEqual(restoreRecords(records), records);
	assert.equal(
		restoreRecords({ ...records, receipts: [{ ...records.receipts[0], fullOutputFile: "../secret" }] }),
		undefined,
	);
});

test("receipts preserve real failures despite successful prose; usage uses final messages only", () => {
	const message = { role: "assistant", content: "all passed\u2028really", usage };
	const result = {
		content: [{ type: "text", text: "SECRET output" }],
		structuredContent: {
			output: "SECRET output",
			exit_code: 7,
			truncated: true,
			wall_time_seconds: 0.4,
			full_output_path: "/missing/SECRET.log",
		},
		usage,
	};
	const end = { type: "tool_execution_end", toolCallId: "SECRET-id", toolName: "bash", result, isError: false };
	const records = collectRecords(
		jsonl([
			{ type: "message_update", usage },
			{ type: "tool_execution_start", toolCallId: "SECRET-id", toolName: "bash", args: { command: "SECRET" } },
			end,
			end,
			{ type: "message_end", message },
			{ type: "turn_end", message, toolResults: [{ role: "toolResult", usage }] },
			{ type: "message_end", message: { role: "toolResult", usage } },
			{ type: "agent_end", messages: [message] },
			{ type: "agent_settled" },
		]),
	);
	assert.equal(records.toolCalls, 1);
	assert.equal(records.failedCalls, 1);
	assert.equal(records.receipts[0]?.status, "error");
	assert.equal(records.receipts[0]?.exitCode, 7);
	assert.equal(records.receipts[0]?.durationMs, 400);
	assert.equal(records.receipts[0]?.outputTruncated, true);
	assert.match(records.receipts[0]?.outputRef ?? "", /^sha256:[a-f0-9]{64}$/);
	assert.equal(records.streamIncomplete, false);
	assert.equal(records.usage.assistantResponses, 1);
	assert.equal(records.usage.nestedUsageReports, 1);
	assert.equal(records.usage.totalTokens, 32);
	assert.equal(records.usage.estimatedCostUSD, 0.02);
	assert.doesNotMatch(JSON.stringify(records), /SECRET|missing/);
	assert.deepEqual(restoreRecords(records), records);
});

test("Pi 1.1.0 tool execution duration wins over the bash wall time", () => {
	const records = collectRecords(
		jsonl([
			{ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: {} },
			{
				type: "tool_execution_end",
				toolCallId: "a",
				toolName: "bash",
				isError: false,
				durationMs: 250,
				result: {
					content: [{ type: "text", text: "ok" }],
					structuredContent: { exit_code: 0, wall_time_seconds: 0.4 },
				},
			},
			{ type: "agent_settled" },
		]),
	);
	assert.equal(records.receipts[0]?.durationMs, 250);
});

test("incoherent usage is rejected by restoreRecords just like restoreAccounting", () => {
	const records = collectRecords(
		jsonl([{ type: "message_end", message: { role: "assistant", usage } }, { type: "agent_settled" }]),
	);
	assert.deepEqual(restoreRecords(records), records);
	assert.equal(restoreRecords({ ...records, usage: { ...records.usage, tokenReports: 5 } }), undefined);
	assert.equal(restoreRecords({ ...records, usage: { ...records.usage, costReports: 5 } }), undefined);
});

test("missing exits, malformed streams and unfinished calls never become passed checks", () => {
	const records = collectRecords(
		jsonl([
			{ type: "tool_execution_start", toolCallId: "unfinished", toolName: "read", args: { path: "README.md" } },
			{
				type: "tool_execution_end",
				toolCallId: "bash",
				toolName: "bash",
				isError: false,
				result: { content: [{ type: "text", text: "passed" }] },
			},
			{ type: "tool_execution_end", toolCallId: "unknown", toolName: "token=SECRET", result: null },
			{
				type: "tool_execution_end",
				toolCallId: "read",
				toolName: "read",
				isError: false,
				result: { content: [], details: { truncation: { truncated: true } } },
			},
			{
				type: "tool_execution_end",
				toolCallId: "failure",
				toolName: "bash",
				isError: true,
				result: { content: [{ type: "text", text: "Command timed out" }] },
			},
			{ type: "agent_settled" },
		]) + '{"type":',
	);
	assert.deepEqual(
		records.receipts.map((receipt) => receipt.status),
		["unfinished", "unknown", "unknown", "ok", "error"],
	);
	assert.equal(records.receipts[2]?.tool, "unknown");
	assert.equal(records.receipts[3]?.outputTruncated, true);
	assert.equal(records.streamIncomplete, true);
	assert.equal(records.receipts[1]?.outputTruncated, undefined);
	assert.equal(records.receipts[4]?.exitCode, undefined);
	assert.equal(records.usage.totalTokens, undefined);
	assert.equal(collectRecords("stderr-like non JSON").streamIncomplete, true);
	assert.equal(collectRecords("").toolCalls, 0);
});

test("receipt retention is bounded, detaches snapshots and rejects unsafe persisted extras", () => {
	const records = collectRecords(
		jsonl(
			Array.from({ length: 25 }, (_, i) => ({
				type: "tool_execution_end",
				toolCallId: String(i),
				toolName: "ls",
				isError: i < 5,
				result: { content: [] },
			})),
		),
	);
	assert.equal(records.toolCalls, 25);
	assert.equal(records.omitted, 5);
	assert.equal(records.failedCalls, 5, "omitted failures still appear in totals");
	assert.equal(records.receipts.length, 20);
	const detached = restoreRecords(records);
	assert.ok(detached);
	detached.receipts.pop();
	assert.equal(records.receipts.length, 20);
	assert.equal(restoreRecords({ ...records, omitted: 0 }), undefined);
	assert.equal(restoreRecords({ ...records, failedCalls: 6 }), undefined);
	assert.equal(restoreRecords({ ...records, stderr: "SECRET" }), undefined);
	assert.equal(restoreRecords({ ...records, receipts: [...records.receipts, records.receipts[0]] }), undefined);
	assert.equal(restoreRecords(null), undefined);
});

test("missing/placeholder usage is unknown; reports are estimates and partial totals stay visible", () => {
	const accounting = newAccounting();
	accounting.main.runs = 2;
	const totals = emptyUsage();
	recordUsage(totals, { role: "assistant", usage });
	recordUsage(totals, { role: "assistant", usage: { ...usage, totalTokens: 0, cost: { total: 0 } } });
	recordUsage(totals, { role: "toolResult" });
	recordUsage(totals, { role: "user", usage });
	finishRun(accounting.main, 12.4, totals);
	finishRun(accounting.main, 4, emptyUsage());
	assert.equal(accounting.main.durationMs, 16);
	assert.equal(accounting.main.usage.totalTokens, 16);
	assert.equal(accounting.main.usage.tokenReports, 1);
	assert.equal(accounting.main.unreportedRuns, 1);
	assert.match(accountingText(accounting), /tokens 16 \(partial\)/);
	assert.match(accountingText(accounting), /verifier:.*tokens unknown.*USD unknown/);
	assert.deepEqual(restoreAccounting(accounting), accounting);
	const restored = restoreAccounting(accounting);
	assert.ok(restored);
	restored.main.runs = 50;
	assert.equal(accounting.main.runs, 2);
	assert.equal(restoreAccounting({ ...accounting, extra: "SECRET" }), undefined);
	assert.equal(restoreAccounting({ ...accounting, main: { ...accounting.main, runs: 0 } }), undefined);
	assert.equal(restoreAccounting({ ...accounting, main: { ...accounting.main, unreportedRuns: 3 } }), undefined);
	const invalid = emptyUsage();
	recordUsage(invalid, { role: "assistant", usage: { ...usage, input: -1, cost: { total: Infinity } } });
	assert.equal(invalid.totalTokens, undefined);
	assert.equal(invalid.estimatedCostUSD, undefined);
});
