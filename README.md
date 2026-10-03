# pi-quest

Persistent goals for [Pi](https://pi.dev): set an objective and the agent keeps working across turns — auto-continued, verified, and auto-paused when it stalls — instead of stopping after one answer.

Pairs with [pi-doom-loop](https://github.com/bgtendtofree/pi-doom-loop): doom-loop is the micro layer (same action spinning, mid-turn steer), pi-quest is the macro layer (varied actions, zero forward progress, round-boundary verification). Neither depends on the other.

```text
/goal Migrate the auth module to JWT, all tests green --max-turns 20
```

Then walk away. At every pre-settlement boundary the goal is verified; if it's not done, Pi's native `agent_before_settle` hook requests a continuation with the verifier's gaps. JSON/RPC clients receive `agent_settled` only after the loop stops, not between rounds. Submitting a user message suspends the loop until `/goal resume`.

## Lifecycle

```text
/goal <objective> [--max-turns N]   set (cap defaults to 20 auto-continuations)
/goal status | pause | resume | clear
```

Statuses: `active · user_paused · no_progress_paused · budget_paused · blocked · complete`.

| Exit | Trigger |
|---|---|
| `complete` | verifier reports achieved |
| `no_progress_paused` | identical verifier-gap fingerprint twice in a row |
| `budget_paused` | max continuations used; agent gets a wrap-up turn to summarize |
| `blocked` | verifier reports only non-model-fixable gaps |
| `user_paused` | `/goal pause`, aborted/failed agent run, or restored from a previous session/branch |

A goal restored from a previous session or `/tree` branch **never re-arms itself**: it comes back `user_paused` and waits for `/goal resume`. (`/reload` keeps continuity.) `/goal clear` writes a tombstone so the goal stays cleared across restores. Pause, clear, user input, session changes, and shutdown cancel any running verifier. Resume resets the stall streak, not the continuation budget.

## Model-facing goal query

`quest_get_goal({})` returns `{ "goal": null }` when unset, otherwise a detached snapshot with the objective, status, suspension flag, round, remaining auto-continuations, previous gaps, pause reason, and latest verification. It cannot create, modify, resume, or complete a goal and does not spend continuation budget.

The tool has a native output schema and read-only annotations. When the main session has Pi's native codemode enabled, `await tools.quest_get_goal({})` returns the same structured snapshot; quest does not enable codemode or change the user's tool selection.

Query output limits the objective to 4096 characters and each gap/reason to 512 characters, with at most 10 gaps. `truncated: true` marks omitted content; the stored objective and continuation gaps remain unchanged.

## Verification

Every pre-settlement round spawns an **adversarial skeptic**: a fresh `pi --mode json -p --no-session` process (`src/verifier.ts`) using the host Pi installation and the physical model/thinking level of the latest successful assistant response. This follows model switches and virtual-model routing without loading the router in the child. It gets the objective plus `git diff` against the goal's baseline commit (captured at `/goal` time), re-runs the acceptance checks against the real worktree — tests, builds, scripts — and reports a strict JSON verdict:

```json
{"achieved": false, "gaps": ["3 auth tests still fail"], "model_fixable": true, "blocker": null}
```

`achieved` completes the goal; `gaps` are inlined into the next continuation; `model_fixable: false` blocks it for a human decision. Identical gap sets twice in a row (normalized fingerprint) trip the no-progress pause. A skeptic that crashes, times out (10 min), or returns unparseable output is **fail-open**: the round counts as unverified and the loop continues — an internal failure never blocks or silently completes a goal.

The skeptic is instructed to assess **every objective requirement** as verified, unverified, or unmet before its final JSON verdict. A passing test is not proof of the entire objective. Documentation and research goals are checked against their actual deliverables; they do not require a test command merely to complete.

`/goal status` and `quest_get_goal` show a bounded, branch-local `lastVerification` record: outcome (`verified-achieved`, `verified-incomplete`, or `unverified`), round, duration in milliseconds, model when known, and gaps or a failure category (`timeout`, `process`, `model`, `output`). Unknown model information is omitted, not inferred from the main session. Fixed failure descriptions replace raw stderr/provider/exception messages so credentials are not copied into session entries. Cancelled and stale verifications never overwrite the record. Old sessions without this optional field still restore.

These outcomes report the independent skeptic's judgment, not a deterministic proof that all requirements were covered. Per-requirement assessment is a prompt contract; runtime collection of check receipts, full logs, and token/cost accounting remain future work.

The skeptic disables extensions (including built-in MCP/codemode), skills, prompt templates, context files, project trust, and background network activity. A failed, aborted, or truncated assistant response never completes a goal, even when JSON mode exits with code zero.

Providers registered only by extensions and credentials supplied only to an SDK runtime are not inherited by the child. Such verifier failures remain unverified; use a physical provider/model configured in Pi's stored settings or environment.

**Safety:** the skeptic's tools omit `edit` and `write`, but `bash` and existing check scripts can still modify files or access credentials/network. Prompt instructions and `--no-approve` are not a sandbox. Run untrusted repositories inside an isolated environment.

Design rationale: [pi-doom-loop docs/goal-plugin-design.md](https://github.com/bgtendtofree/pi-doom-loop/blob/main/docs/goal-plugin-design.md).

## Install

Requires Pi **1.0.1+** and Node **24+**. Development and packed-package checks target Pi 1.0.1; peer dependencies remain `"*"` per Pi's host-module contract.

```bash
pi install git:github.com/bgtendtofree/pi-quest
```

## Development

Node 24.19.0 via `mise.toml`. `mise run check` while iterating, `mise run ci` before shipping (biome + tsc + node:test with coverage gates + packed-package smoke).

## License

MIT
