# Subagent extension

Delegate tasks to specialized agents with isolated context (`pi --mode json` child processes).

## Layout

| File | Contents |
|---|---|
| `index.ts` | Tool wiring only (`subagent`, `swarm_status/cancel/resume/gc`, `/swarm-gc`) + TUI renderers |
| `types.ts` | `SingleResult`, `SwarmInfo`, `SubagentDetails`, `SwarmCtx`, dispatch types |
| `single.ts` | `runSingleAgent()` — one isolated child process + streaming + process-group kill |
| `parallel.ts` | `runParallel()` — concurrency 4, per-task retry, total budget |
| `chain.ts` | `runChain()` — sequential `{previous}`, per-step retry, `onError` |
| `swarm-orchestrator.ts` | `runSwarm()`, `validateWorkers()`, `resumeMissingWorkers()` |
| `schema.ts` | TypeBox params (incl. `retry`/`totalTimeoutMs`/`onError`) |
| `resilience.ts` | `runWithRetry()` (default retry once), `totalDeadline()`, `recommendedTotalTimeout()` |
| `render.ts` | Shared TUI primitives: `formatToolCall`, `resultBadges`, `formatTotals`, `truncatePreview` |
| `agents.ts` | Agent discovery (fail-closed, symlink containment, user-shadows-project) |
| `swarm.ts` | Blackboard I/O: `manifest.json`, `cancel.json`, validated outbox, fork-resume, GC |

## Modes

| Mode | Params | Notes |
|---|---|---|
| single | `agent`, `task`, `cwd?`, `timeoutMs?` | Retried once by default |
| parallel | `tasks[{agent,task,cwd?,timeoutMs?}]` | Max 8 tasks, concurrency 4, abort/budget drains queue |
| chain | `chain[{agent,task,cwd?,timeoutMs?}]` | Sequential, `{previous}` = capped prior output; `onError: abort` (default) or `continue` |
| swarm | `swarm{goal, workers[{id,agent,task,cwd?,timeoutMs?}], merger?, cleanup?}` | Blackboard `.swarm/<runId>/`, depth ≤3, total ≤8 |

Common: `retry {attempts (default 2), backoffMs (default 1000)}`, `totalTimeoutMs` (whole-operation
budget, default unset = unbounded; chain recommends sum of steps, parallel/swarm max + 60s),
`timeoutMs` per agent (default 300000, max 1800000). Timeout kills the
process group (SIGTERM → SIGKILL after 5s) and returns partial output with
`errorCode: "timeout"`.

## Result fields

`SingleResult`: `exitCode`, `stopReason`, `errorCode` (`ok` | `spawn-failed` | `timeout` |
`aborted` | `non-zero` | `setup-error` | `budget-exceeded`), `timedOut`, `durationMs` (wall clock),
`attempts`, `usage`, `messages`. TUI shows `⏱ 4m12s` + `[errorCode]` badges; totals show
`wall (sum)` for chain, `wall (max)` for parallel/swarm.

## Swarm blackboard

`<cwd>/.swarm/<runId>/{manifest.json,tasks.jsonl,inbox/<id>.jsonl,outbox.jsonl,done/<id>.md,cancel.json?}`.
`tasks.jsonl` records goal + worker specs **including task text** (so forks can resume precisely).
`manifest.json` tracks `{runId, parentRunId?, goal, workers, status, createdAt}`.
`swarm.cleanup:true` deletes the whole `runId/` dir on full success (workers + merger
all succeed, no abort); failures always keep the blackboard.

Outbox writes are validated (`from`/`body` required, body capped); merger input is
byte-budget packed (`MERGER_INPUT_BUDGET`, deterministic id order, omitted count reported).

Fork-resume: `swarm_resume {runId, merger?, cleanup?}` creates `<runId>-rN` (parent untouched),
copies parent `done/*.md`, runs only missing workers, then the merger.

Admin: `swarm_status {runId}`, `swarm_cancel {runId, reason?}` (writes `cancel.json`,
workers stop between tasks).

GC (conservative AND-predicate — a run is deleted only when **older than N days AND
outside newest M**):

* Tool: `swarm_gc {olderThanDays?, keepLastN?, apply?}` (dry-run unless `apply:true`)
* Command: `/swarm-gc [--older-than N] [--keep-last N] [--apply]` (defaults 7d / 10)

## Limits

`MAX_PARALLEL_TASKS=8`, `MAX_CONCURRENCY=4`, `MAX_SWARM_DEPTH=3`, `MAX_SWARM_TOTAL=8`,
`STDOUT_CAP=2MB`, `STDERR_CAP=128KB`, `MAX_MESSAGES=500`.
