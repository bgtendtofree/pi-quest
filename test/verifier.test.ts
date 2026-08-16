import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { GoalState } from "../src/index.ts";
import { buildSkepticPrompt, createSkepticVerifier, type ExecFn, parseVerdict } from "../src/verifier.ts";

describe("parseVerdict", () => {
	test("parses the fenced json block", () => {
		const text =
			'I ran the tests.\n\n```json\n{"achieved": false, "gaps": ["3 tests fail"], "model_fixable": true, "blocker": null}\n```\n';
		const verdict = parseVerdict(text);
		assert.equal(verdict?.achieved, false);
		assert.deepEqual(verdict?.gaps, ["3 tests fail"]);
		assert.equal(verdict?.modelFixable, true);
	});

	test("parses a fenced json block without a newline", () => {
		const verdict = parseVerdict('```json {"achieved": true, "gaps": []}```');
		assert.equal(verdict?.achieved, true);
	});

	test("achieved with empty gaps", () => {
		const verdict = parseVerdict(
			'```json\n{"achieved": true, "gaps": [], "model_fixable": true, "blocker": null}\n```',
		);
		assert.equal(verdict?.achieved, true);
	});

	test("falls back to a bare trailing object without a fence", () => {
		const verdict = parseVerdict('analysis...\n{"achieved": false, "gaps": ["no tests"], "model_fixable": true}');
		assert.equal(verdict?.achieved, false);
	});

	test("parses a bare verdict starting at first character", () => {
		const verdict = parseVerdict('{"achieved": true, "gaps": []}');
		assert.equal(verdict?.achieved, true);
	});

	test("blocked verdict carries the blocker", () => {
		const verdict = parseVerdict(
			'```json\n{"achieved": false, "gaps": ["needs prod creds"], "model_fixable": false, "blocker": "needs prod creds"}\n```',
		);
		assert.equal(verdict?.modelFixable, false);
		assert.equal(verdict?.blocker, "needs prod creds");
	});

	test("model_fixable defaults to true when missing", () => {
		const verdict = parseVerdict('```json\n{"achieved": false, "gaps": ["x"]}\n```');
		assert.equal(verdict?.modelFixable, true);
	});

	test("non-string gaps are filtered out", () => {
		const verdict = parseVerdict('```json\n{"achieved": false, "gaps": ["real", 42, null]}\n```');
		assert.deepEqual(verdict?.gaps, ["real"]);
	});

	test("unparseable output returns undefined (caller treats as fail-open)", () => {
		assert.equal(parseVerdict("the model rambled without any json"), undefined);
		assert.equal(parseVerdict("```json\n{not json}\n```"), undefined);
		assert.equal(parseVerdict('{"done": true}'), undefined); // no "achieved" key
	});
});

describe("buildSkepticPrompt", () => {
	test("carries objective and diff", () => {
		const prompt = buildSkepticPrompt("migrate auth", "diff --git a/x b/x");
		assert.match(prompt, /migrate auth/);
		assert.match(prompt, /diff --git/);
		assert.match(prompt, /adversarial verifier/i);
	});
});

describe("skeptic worktree verification", () => {
	const goal: GoalState = {
		objective: "do the thing",
		status: "active",
		round: 0,
		autoTurns: 0,
		maxTurns: 20,
		suspended: false,
		cwd: "/tmp/x",
		baselineCommit: "abc123",
		stallCount: 0,
	};

	const verdictText = '```json\n{"achieved": false, "gaps": ["gap one"], "model_fixable": true}\n```';
	const jsonl = `${JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: verdictText }] },
	})}\n`;

	function mockExec(tree: { status: string; diff: string }): { exec: ExecFn; spawns: () => number } {
		let spawns = 0;
		const exec: ExecFn = async (command, args) => {
			if (command === "git") {
				const isStatus = args.includes("status");
				return { stdout: isStatus ? tree.status : tree.diff, stderr: "", code: 0, killed: false };
			}
			spawns += 1;
			return { stdout: jsonl, stderr: "", code: 0, killed: false };
		};
		return { exec, spawns: () => spawns };
	}

	test("unchanged worktree still triggers a fresh skeptic run", async () => {
		const { exec, spawns } = mockExec({ status: "M a.ts", diff: "some diff" });
		const verify = createSkepticVerifier(exec, goal);
		await verify("do the thing", 1);
		await verify("do the thing", 2);
		assert.equal(spawns(), 2);
	});

	test("changed worktree triggers a fresh skeptic run", async () => {
		const state = { status: "M a.ts", diff: "some diff" };
		const { exec, spawns } = mockExec(state);
		const verify = createSkepticVerifier(exec, goal);
		await verify("do the thing", 1);
		state.diff = "new diff";
		await verify("do the thing", 2);
		assert.equal(spawns(), 2);
	});

	test("git failure never skips verification", async () => {
		let spawnCount = 0;
		const exec: ExecFn = async (command) => {
			if (command === "git") return { stdout: "", stderr: "fatal", code: 128, killed: false };
			spawnCount += 1;
			return { stdout: jsonl, stderr: "", code: 0, killed: false };
		};
		const verify = createSkepticVerifier(exec, goal);
		await verify("do the thing", 1);
		await verify("do the thing", 2);
		assert.equal(spawnCount, 2);
	});
});
