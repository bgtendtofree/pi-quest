# pi-quest

Persistent goals for [Pi](https://pi.dev): set an objective and the agent keeps working across turns — auto-continued, verified, and auto-paused when it stalls — instead of stopping after one answer.

Pairs with [pi-doom-loop](https://github.com/bgtendtofree/pi-doom-loop): doom-loop is the micro layer (same action spinning, mid-turn steer), pi-quest is the macro layer (varied actions, zero forward progress, round-boundary verification). Neither depends on the other.

```text
/goal Migrate the auth module to JWT, all tests green --max-turns 20
```

Then walk away. After every settled run the goal is verified; if it's not done, a continuation with the verifier's gaps is sent automatically. You can keep typing — typing suspends the loop until `/goal resume`.

## Lifecycle

```text
/goal <objective> [--max-turns N]   set (cap defaults to 20 auto-continuations)
/goal status | pause | resume | clear
```

Statuses: `active · user_paused · no_progress_paused · budget_paused · blocked · complete`.

| Exit | Trigger |
|---|---|
| `complete` | verifier reports achieved |
| `no_progress_paused` | identical verifier-gap fingerprint twice in a row (Grok Build's stall exit) |
| `budget_paused` | max continuations used; agent gets a wrap-up turn to summarize |
| `blocked` | verifier reports only non-model-fixable gaps |
| `user_paused` | `/goal pause`, or restored from a previous session |

A goal restored from a previous session **never re-arms itself**: it comes back `user_paused` and waits for `/goal resume`. (`/reload` keeps continuity.) `/goal clear` writes a tombstone so the goal stays cleared across restores.

## Verification

Every settled round spawns an **adversarial skeptic**: a fresh `pi --mode json -p --no-session` process (`src/verifier.ts`) that gets the objective plus `git diff` against the goal's baseline commit (captured at `/goal` time), re-runs the acceptance checks against the real worktree — tests, builds, scripts — and reports a strict JSON verdict:

```json
{"achieved": false, "gaps": ["3 auth tests still fail"], "model_fixable": true, "blocker": null}
```

`achieved` completes the goal; `gaps` are inlined into the next continuation; `model_fixable: false` blocks it for a human decision. Identical gap sets twice in a row (normalized fingerprint) trip the no-progress pause. A skeptic that crashes, times out (10 min), or returns unparseable output is **fail-open**: the round counts as unverified and the loop continues — an internal failure never blocks or silently completes a goal.

Design rationale: [pi-doom-loop docs/goal-plugin-design.md](https://github.com/bgtendtofree/pi-doom-loop/blob/main/docs/goal-plugin-design.md).

## Install

```bash
pi install git:github.com/bgtendtofree/pi-quest
```

## Development

Node 24.19.0 via `mise.toml`. `mise run check` while iterating, `mise run ci` before shipping (biome + tsc + node:test with coverage gates + packed-package smoke).

## License

MIT
