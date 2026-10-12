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
| `no_progress_paused` | identical verifier-gap fingerprint twice in a row, or an unchanged worktree since the last verification |
| `budget_paused` | max continuations used; agent gets a wrap-up turn to summarize |
| `blocked` | verifier reports only non-model-fixable gaps |
| `user_paused` | `/goal pause`, aborted/failed agent run, or restored from a previous session/branch |

A goal restored from a previous session or `/tree` branch **never re-arms itself**: it comes back `user_paused` and waits for `/goal resume`. (`/reload` keeps continuity.) `/goal clear` writes a tombstone so the goal stays cleared across restores. Pause, clear, user input, session changes, and shutdown cancel any running verifier. Resume resets the stall streak, not the continuation budget.

## Model-facing goal query

`quest_get_goal({})` returns `{ "goal": null }` when unset, otherwise a detached snapshot with the objective, status, suspension flag, round, remaining auto-continuations, previous gaps, pause reason, and latest verification. It cannot create, modify, resume, or complete a goal and does not spend continuation budget.

The tool has a native output schema and read-only annotations. When the main session has Pi's native codemode enabled, `await tools.quest_get_goal({})` returns the same structured snapshot; quest does not enable codemode or change the user's tool selection.

Query output limits the objective to 4096 characters and each gap/reason to 512 characters, with at most 10 gaps. `truncated: true` marks omitted content; the stored objective stays complete, while stored and continuation gaps share the same 10×512 bound.

## Verification

Every pre-settlement round spawns an **adversarial skeptic**: a fresh `pi --mode json -p --no-session` process (`src/verifier.ts`) using the host Pi installation and the physical model/thinking level of the latest successful assistant response. This follows model switches and virtual-model routing without loading the router in the child. It gets the objective plus `git diff` against the goal's baseline commit (captured at `/goal` time), re-runs the acceptance checks against the real worktree — tests, builds, scripts — and reports a strict JSON verdict:

```json
{"achieved": false, "gaps": ["3 auth tests still fail"], "model_fixable": true, "blocker": null}
```

`achieved` completes the goal; `gaps` are inlined into the next continuation; `model_fixable: false` blocks it for a human decision. Identical gap sets twice in a row (normalized fingerprint) trip the no-progress pause, and so does an **unchanged worktree** (same HEAD + status + diff as the last real verification): the skeptic is skipped and the round counts as no progress. A skeptic that crashes, times out (10 min), or returns unparseable output is **fail-open**: the round counts as unverified and the loop continues — an internal failure never blocks or silently completes a goal. A blocked verdict with neither gaps nor a named blocker is incoherent and is treated as unverified too.

The skeptic is instructed to assess **every objective requirement** as verified, unverified, or unmet before its final JSON verdict. A passing test is not proof of the entire objective. Documentation and research goals are checked against their actual deliverables; they do not require a test command merely to complete.

`/goal status` and `quest_get_goal` show a bounded, branch-local `lastVerification` record: outcome (`verified-achieved`, `verified-incomplete`, or `unverified`), round, duration in milliseconds, model when known, and gaps or a failure category (`timeout`, `process`, `model`, `output`). Unknown model information is omitted, not inferred from the main session. Fixed failure descriptions replace raw stderr/provider/exception messages so credentials are not copied into session entries. Cancelled and stale verifications never overwrite the record. Old sessions without this optional field still restore.

These outcomes report the independent skeptic's judgment, not a deterministic proof that all requirements were covered. Per-requirement assessment remains a prompt contract; execution receipts do not replace the independent verdict.

### Execution receipts and usage

`lastVerification.records` collects **actual child CLI events**, never claims in assistant prose. It keeps at most 20 tool receipts per verification, with total/failed/omitted counts and a `streamIncomplete` flag for missing settlement, malformed JSONL or unfinished calls. Failure totals include omitted receipts. Receipts retain tool/event source, status (`ok`, `error`, `unknown`, `unfinished`), reported exit code, duration and truncation when available. Bash requires a reported zero exit code and a non-error result to receive `ok`; absent exit information remains unknown. Failed receipts stay failed even if the final verdict claims success. An unrelated failed command does not automatically veto a goal.

Call IDs, arguments and output are stored only as SHA-256 fingerprints (`callRef`, `argsRef`, `outputRef`); nested calls also retain a hashed `parentRef`. These fingerprints identify received data, **not recoverable logs or proof of requirement coverage**. When Pi spills output, `fullOutputFile` retains only a validated native filename (`pi-bash-<hex>.log` or `pi-codemode-<hex>.txt`) inside Node's `os.tmpdir()`, not arbitrary paths. Availability is unknown: the file can disappear or belong to an earlier machine/session. Quest creates no full-output log cache, copies no raw command/output into receipts, and never reads or deletes native Pi logs. Native logs may contain sensitive output; retention and cleanup remain with Pi/the OS/user. Missing files do not change goal state. Summaries live in branch-local session entries; `/goal clear` clears current state, not historical entries. Delete the session file to remove its retained history.

`accounting.main` and `accounting.verifier` are optional cumulative, branch-local records, available through `quest_get_goal` and `/goal status`:

- Main runs are goal-owned assistant turns, including the budget wrap-up; duration spans model and tool execution, not idle time or verification.
- Verifier runs are independent verification attempts, including diff capture, child execution and parsing. Failed attempts count once. Cancelled/stale attempts retain their start count but cannot publish late duration, usage or receipts; `completedRuns < runs` marks incomplete accounting.
- Usage sums finalized assistant messages and **reported top-level tool-result usage**, once. Streaming deltas, `turn_end`/`agent_end` transcript copies and nested tool execution events are not additional charges. Verifier usage covers every response, not just the verdict.
- Token fields keep input/output/cache-read/cache-write/total separate; reasoning tokens are already included in output. Missing or all-zero placeholder usage stays unknown. Cost is Pi's **estimate**, not an invoice; zero estimates stay unknown because unpriced models also report zero. Known subtotals with missing reports are marked partial.
- Unreported nested model work, compaction/branch-summary calls, cache warming and model calls made externally by scripts are outside these counters. No token/cost hard budget is enabled.

The skeptic disables discovered extensions, skills, prompt templates, context files, project trust, built-in MCP (`--no-mcp`), and background network activity. Experimental codemode, below, is the only explicitly loaded exception. A failed, aborted, or truncated assistant response never completes a goal, even when JSON mode exits with code zero.

### Experimental verifier codemode (default off)

Opt in for one host invocation:

```sh
pi --quest-verifier-codemode
# Explicit extension loading:
pi -e ./src/index.ts --quest-verifier-codemode
```

Omit the flag to use the original verifier. It does not change `/goal` syntax, saved goals, user settings, main-session tools, completion authority, cancellation, stall limits or settlement. SDK callers can pass `{ codemode: true }` to `createSkepticVerifier`.

The child adds `codemode` to the existing `read,grep,find,ls,bash` allowlist and explicitly loads `src/verifier-codemode.ts`. This tiny adapter uses Pi's public `createCodemodeExtension({ models: false, mode: "only" })`, **not a custom executor**. When opted in, only `codemode` is declared to the verifier model; the allowlisted checks remain callable as `tools.*` inside scripts. This is a code-only route, not an extra optional tool beside direct calls. The CLI's `builtin:codemode` alias exposes `models.*` by default without a CLI off switch, so the adapter avoids unintended classifier/image calls. Main-session codemode remains user-controlled and can have different capabilities. Chat verification still incurs normal model charges; bash/scripts can still call external services.

Codemode guidance recommends independent reads, bounded output filtering and independent checks; shared build/database state must not be parallelized. Bash promises can resolve with nonzero exit codes: exit codes, failure output, truncation and available native log references must survive filtering. Parent script success cannot rewrite failed nested receipts.

`test/codemode.test.ts` compares fixed documentation, passing/failing checks, missing-evidence and script-error fixtures using real native tools and **mocked chat responses**. It reports duration and reported mock usage, checks equal underlying tool coverage, and exercises nested cancellation, disabled `models.*` and spill references. JSON/RPC SDK lifecycle tests cover single settlement after completion, budget wrap-up and stall. These are protocol regressions, **not evidence of live-model performance gains or requirement coverage**.

Historical live comparisons used the user's configured `deepseek/deepseek-flash` with the old `mode: "on"` adapter; they measured **optional tool availability, not code-only execution**. Initial `thinking=off` also did not represent the user's saved thinking setting. The adapter now uses `mode: "only"`; SDK regressions assert the model sees only the `codemode` declaration while scripts retain the exact check allowlist.

The corrected live comparison uses `thinking=high` as requested, with Git baselines for unchanged-fixture requirements. Both paths matched expectations in 8/8 small cases; all code-only attempts actually used scripts (29 calls, zero direct check calls). Code-only averaged 11.11s versus 9.43s direct on these tiny fixtures, not evidence about larger batching workloads. See [UPGRADE_PLAN.md](UPGRADE_PLAN.md) for distinct measurements, excluded harness-limited runs and costs. Live requests are manual, never part of CI; historical optional-tool results are not evidence against the current code-only route. Production thinking still follows the host session, not a hardcoded benchmark level.

Providers registered only by extensions and credentials supplied only to an SDK runtime are not inherited by the child. Such verifier failures remain unverified; use a physical provider/model configured in Pi's stored settings or environment.

**Safety:** the skeptic's tools omit `edit` and `write`, but `bash` and existing check scripts can still modify files or access credentials/network. Prompt instructions and `--no-approve` are not a sandbox. Run untrusted repositories inside an isolated environment.

Design rationale: [pi-doom-loop docs/goal-plugin-design.md](https://github.com/bgtendtofree/pi-doom-loop/blob/main/docs/goal-plugin-design.md).

## Install

Requires Pi **1.1.0+** and Node **24+**. Development and packed-package checks target Pi 1.1.0; peer dependencies remain `"*"` per Pi's host-module contract.

```bash
pi install git:github.com/bgtendtofree/pi-quest
```

## Development

Node 24.19.0 via `mise.toml`. `mise run check` while iterating, `mise run ci` before shipping (biome + tsc + node:test with coverage gates + packed-package smoke).

## License

MIT
