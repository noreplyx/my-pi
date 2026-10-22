# Subagent extension

Delegate tasks to specialized agents with isolated context (`pi --mode json` child processes).

## Modes

| Mode | Params | Notes |
|---|---|---|
| single | `agent`, `task`, `cwd?`, `timeoutMs?` | One agent, 5min default timeout |
| parallel | `tasks[{agent,task,cwd?,timeoutMs?}]` | Max 8 tasks, concurrency 4, abort drains queue |
| chain | `chain[{agent,task,cwd?,timeoutMs?}]` | Sequential, `{previous}` = capped prior output |
| swarm | `swarm{goal, workers[{id,agent,task,cwd?,timeoutMs?}], merger?, cleanup?}` | Blackboard `.swarm/<runId>/`, depth ≤3, total ≤8 |

`timeoutMs`: per-agent wall-clock budget (default 300000, max 1800000). Timeout kills the
process group (SIGTERM → SIGKILL after 5s) and returns partial output with
`errorCode: "timeout"`.

## Result fields

`SingleResult`: `exitCode`, `stopReason`, `errorCode` (`ok` | `spawn-failed` | `timeout` |
`aborted` | `non-zero` | `setup-error`), `timedOut`, `durationMs` (wall clock),
`usage`, `messages`. TUI shows `⏱ 4m12s` + `[errorCode]` badges; totals show wall time
(sum for chain, max for parallel/swarm).

## Swarm blackboard

`<cwd>/.swarm/<runId>/{tasks.jsonl,inbox/<id>.jsonl,outbox.jsonl,done/<id>.md}`.
`swarm.cleanup:true` deletes the whole `runId/` dir on full success (workers + merger
all succeed, no abort); failures always keep the blackboard.

GC (conservative AND-predicate — a run is deleted only when **older than N days AND
outside newest M**):

* Tool: `swarm_gc {olderThanDays?, keepLastN?, apply?}` (dry-run unless `apply:true`)
* Command: `/swarm-gc [--older-than N] [--keep-last N] [--apply]` (defaults 7d / 10)

## Limits

`MAX_PARALLEL_TASKS=8`, `MAX_CONCURRENCY=4`, `MAX_SWARM_DEPTH=3`, `MAX_SWARM_TOTAL=8`,
`STDOUT_CAP=2MB`, `STDERR_CAP=128KB`, `MAX_MESSAGES=500`.
