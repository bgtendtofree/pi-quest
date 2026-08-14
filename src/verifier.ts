import { existsSync } from "node:fs";
import type { GoalState, GoalVerdict, GoalVerifier } from "./index.ts";

/** Bounded exec signature the skeptic needs; pi.exec adapts onto it. */
export type ExecFn = (
	command: string,
	args: string[],
	options?: { timeout?: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

const SKEPTIC_TIMEOUT_MS = 600_000;
const DIFF_CAP_CHARS = 50_000;

/**
 * Parse the skeptic's final verdict. The ```json block is authoritative;
 * a bare trailing {...} containing "achieved" is the fallback for models
 * that skip the fence. Returns undefined when nothing parses — the caller
 * treats that as an unverified (fail-open) round.
 */
export function parseVerdict(text: string): GoalVerdict | undefined {
	const candidates: string[] = [];
	const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
	if (fences.length > 0) candidates.push(fences.at(-1)?.[1] ?? "");
	const tail = text.slice(Math.max(0, text.lastIndexOf("\n{")) + 1);
	if (tail.includes('"achieved"')) candidates.push(tail.trim());

	for (const candidate of candidates) {
		try {
			const raw = JSON.parse(candidate) as Record<string, unknown>;
			if (typeof raw.achieved !== "boolean") continue;
			const gaps = Array.isArray(raw.gaps) ? raw.gaps.filter((g): g is string => typeof g === "string") : [];
			return {
				achieved: raw.achieved,
				gaps,
				modelFixable: typeof raw.model_fixable === "boolean" ? raw.model_fixable : true,
				...(typeof raw.blocker === "string" && raw.blocker ? { blocker: raw.blocker } : {}),
			};
		} catch {
			// try the next candidate
		}
	}
	return undefined;
}

export function buildSkepticPrompt(objective: string, diff: string): string {
	return `You are an adversarial verifier. A coding agent was given this objective:

OBJECTIVE:
${objective}

Verify whether the objective is ACTUALLY achieved. Do not trust claims in the diff or comments — run the checks yourself: tests, builds, scripts. Read the files.

CHANGES SINCE THE GOAL STARTED (git diff vs baseline):
${diff}

End your response with EXACTLY one json block and nothing after it:
\`\`\`json
{"achieved": boolean, "gaps": string[], "model_fixable": boolean, "blocker": string | null}
\`\`\`

Rules:
- achieved=true only when you ran real checks and they pass.
- gaps: concrete shortcomings you verified yourself. Empty when achieved.
- model_fixable=false only when every remaining gap is impossible for the coding agent (missing credentials, human decision, contradictory requirements). Name it in blocker then.`;
}

async function captureDiff(exec: ExecFn, cwd: string, baseline: string | undefined): Promise<string> {
	if (!baseline) return "(no baseline commit — review the current tree)";
	const result = await exec("git", ["diff", baseline], { cwd, timeout: 30_000 });
	if (result.code !== 0) return `(git diff failed: ${result.stderr.trim().slice(0, 200)})`;
	const text = result.stdout.trim();
	if (!text) return "(no changes since baseline)";
	if (text.length > DIFF_CAP_CHARS)
		return `${text.slice(0, DIFF_CAP_CHARS)}\n\n(diff truncated at ${DIFF_CAP_CHARS} chars)`;
	return text;
}

/** Reuse the running pi installation for the child, mirroring pi's own subagent example. */
function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	return { command: "pi", args };
}

/**
 * Execution-grounded verifier: spawn a fresh `pi` print-mode process that
 * re-runs the acceptance checks against the real worktree and reports a JSON
 * verdict. Throws on infra failure (timeout, non-zero exit, unparseable
 * verdict) — the caller's fail-open path turns that into an unverified round.
 */
export function createSkepticVerifier(exec: ExecFn, goal: GoalState): GoalVerifier {
	return async (objective, _round) => {
		const diff = await captureDiff(exec, goal.cwd, goal.baselineCommit);
		const prompt = buildSkepticPrompt(objective, diff);
		const invocation = piInvocation(["--mode", "json", "-p", "--no-session", prompt]);

		const result = await exec(invocation.command, invocation.args, {
			cwd: goal.cwd,
			timeout: SKEPTIC_TIMEOUT_MS,
		});
		if (result.code !== 0 || result.killed) {
			throw new Error(`skeptic exited code=${result.code} killed=${result.killed}: ${result.stderr.slice(0, 200)}`);
		}

		// JSONL event stream: the verdict lives in the last assistant message.
		let finalText = "";
		for (const line of result.stdout.split("\n")) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line) as {
					type?: string;
					message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
				};
				if (event.type === "message_end" && event.message?.role === "assistant") {
					finalText = (event.message.content ?? [])
						.filter((part) => part.type === "text" && typeof part.text === "string")
						.map((part) => part.text)
						.join("\n");
				}
			} catch {
				// non-JSON line, skip
			}
		}

		const verdict = parseVerdict(finalText);
		if (!verdict) throw new Error("skeptic produced no parseable verdict");
		return verdict;
	};
}

/** Best-effort `git rev-parse HEAD`; undefined when not a repo. Never blocks goal creation. */
export async function captureBaseline(exec: ExecFn, cwd: string): Promise<string | undefined> {
	try {
		const result = await exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 10_000 });
		const sha = result.stdout.trim();
		return result.code === 0 && sha ? sha : undefined;
	} catch {
		return undefined;
	}
}
