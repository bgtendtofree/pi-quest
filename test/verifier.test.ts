import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildSkepticPrompt, parseVerdict } from "../src/verifier.ts";

describe("parseVerdict", () => {
	test("parses the fenced json block", () => {
		const text =
			'I ran the tests.\n\n```json\n{"achieved": false, "gaps": ["3 tests fail"], "model_fixable": true, "blocker": null}\n```\n';
		const verdict = parseVerdict(text);
		assert.equal(verdict?.achieved, false);
		assert.deepEqual(verdict?.gaps, ["3 tests fail"]);
		assert.equal(verdict?.modelFixable, true);
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
