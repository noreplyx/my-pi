# Subagent extension

Delegate tasks to specialized agents with isolated context (`pi --mode rpc` child processes with question forwarding).

## Layout

| File | Contents |
|---|---|
| `index.ts` | Tool wiring only (`subagent`, `ask_user`, `swarm_status/cancel/resume/gc`, `/swarm-gc`) + TUI renderers |
| `types.ts` | `SingleResult`, `SwarmInfo`, `SubagentDetails`, `SwarmCtx`, `ParentUI`, dispatch types |
| `single.ts` | `runSingleAgent()` — one isolated `--mode rpc` child + UI forwarding + process-group kill |
| `ask-user-tool.ts` | `ask_user` tool (frontmatter-gated, child calls `ctx.ui`, parent proxies) |
| `questions.ts` | Parent-UI bridge: per-run lock factory + global lock, `decideQuestionResponse`, fire-and-forget filter |
| `forwarded-permissions.ts` | Parent-side memo for forwarded child permission prompts (exact-title session cache) |
| `parallel.ts` | `runParallel()` — concurrency 4, per-task retry, total budget |
| `swarm-orchestrator.ts` | `runSwarm()`, `validateWorkers()`, `resumeMissingWorkers()` |
| `schema.ts` | TypeBox params (incl. `retry`/`totalTimeoutMs`/`onError`) |
| `resilience.ts` | `runWithRetry()` (default retry once), `totalDeadline()`, `recommendedTotalTimeout()` |
| `render.ts` | Shared TUI primitives: `formatToolCall`, `resultBadges`, `formatTotals`, `truncatePreview` |
| `agents.ts` | Agent discovery (fail-closed, symlink containment, user-shadows-project) |
| `swarm.ts` | Blackboard I/O: `manifest.json`, `cancel.json`, validated outbox, fork-resume, GC |

## Modes

| Mode | Params | Notes |
|---|---|---|
| single | `agent`, `task`, `cwd?`, `timeoutMs?`, `allowQuestions?`, `questionTimeoutMs?` | Retried once by default |
| parallel | `tasks[{agent,task,cwd?,timeoutMs?,allowQuestions?,questionTimeoutMs?}]` | Max 8 tasks, concurrency 4. `onError=abort` drains queue (no new starts, in-flight drained); default `continue`. Budget/abort also drains queue |
| swarm | `swarm{goal, workers[{id,agent,task,cwd?,timeoutMs?,allowQuestions?,questionTimeoutMs?}], merger?, cleanup?}` | Blackboard `.swarm/<runId>/`, depth ≤3, total ≤8. `onError=abort` drains worker queue (drain-only), default `continue` |

## Questions (Option C)

Children run as `pi --mode rpc` servers. `ask_user` calls and permission
prompts arrive as `extension_ui_request` on stdout; the parent forwards
`select` / `confirm` / `input` to its own `ctx.ui` under a per-run FIFO lock
(single-mode uses the global lock; parallel / swarm runs construct an isolated
lock per run — titles are prefixed `[parallel …]`,
`[swarm <runId>/<workerId>]`), then writes
`extension_ui_response` back to the child's stdin.

* `ask_user` is frontmatter-gated: the child model sees it only when the
  agent's `tools:` lists `ask_user` (via the `--tools` allowlist).
* `allowQuestions:false` (per-task or top-level) auto-dismisses;
  opt-in `questionTimeoutMs` bounds each dialog (no default timeout).
* Permission model (agent-only, no global layer): the parent `subagent`
  invocation is gated by the parent agent's layer; inner child tool calls
  are gated by the target agent's layer. When the target agent's layer
  resolves to `allow`, the child never emits a permission prompt, so
  nothing is forwarded to the parent user.
  `tools:` allowlist and `permissions:` both apply — most restrictive wins.
  Dry-run with `/permissions-check --as-agent <name> …`.
* `editor` / `custom` are rejected visibly (`[question skipped]` in stderr);
  `notify` / `setStatus` / `setWidget` are mirrored one-way and never queued.
* Forwarded permission sessions: when a child permission prompt
  (`Allow …?` with the four session choices, or the legacy three) is answered with
  **Allow for this session**, the parent memoizes it per agent + cwd +
  dialog title for the main session. A repeated identical prompt from a
  later child of the same agent auto-approves without re-prompting
  (`[session-grant (parent)]` in stderr). A different agent, cwd, or
  file/command still prompts. `Allow once`, `Deny`, `Deny with feedback`,
  and dismissals are never memoized (fail-closed). `Deny with feedback` is
  a child-owned two-step flow (select, then free-text input) proxied
  transparently — the parent never memoizes either step. In-memory only,
  cleared on session shutdown.
* No-UI parents (`!ctx.hasUI`, e.g. headless) auto-dismiss with a stderr note,
  preserving the old fail-closed behavior.

Common: `retry {attempts (default 2), backoffMs (default 1000)}`, `totalTimeoutMs` (whole-operation
budget, default unset = unbounded; parallel/swarm recommend max + 60s),
`timeoutMs` per agent (default 300000, max 1800000). Timeout kills the
process group (SIGTERM → SIGKILL after 5s) and returns partial output with
`errorCode: "timeout"`.

## Result fields

`SingleResult`: `exitCode`, `stopReason`, `errorCode` (`ok` | `spawn-failed` | `timeout` |
`aborted` | `non-zero` | `setup-error` | `budget-exceeded`), `timedOut`, `durationMs` (wall clock),
`attempts`, `usage`, `messages`. TUI shows `⏱ 4m12s` + `[errorCode]` badges; totals show
`wall (max)` for parallel/swarm.

## Swarm blackboard

`<cwd>/.swarm/<runId>/{manifest.json,tasks.jsonl,inbox/<id>.jsonl,outbox.jsonl,done/<id>.md,cancel.json?}`.
`tasks.jsonl` records goal + worker specs **including task text** (so forks can resume precisely).
`manifest.json` tracks `{runId, parentRunId?, goal, workers, status, createdAt}`.
`swarm.cleanup:true` deletes the whole `runId/` dir on full success (workers + merger
all succeed, no abort); failures always keep the blackboard.

Outbox writes are validated (`from`/`body` required, body capped); merger input is
byte-budget packed (`MERGER_INPUT_BUDGET`, deterministic id order, omitted count reported).
Merger `task` supports `{previous}` — replaced with the packed worker outputs
(capped by `MERGER_INPUT_BUDGET` via `capMergerInput`/`substituteMergerInput`).

Fork-resume: `swarm_resume {runId, merger?, cleanup?, agentScope?, onError?}` creates `<runId>-rN` (parent untouched),
copies parent `done/*.md`, runs only missing workers, then the merger. Project-local agents require trust-confirm before fork (no `-rN` leak on cancel).

Admin: `swarm_status {runId}`, `swarm_cancel {runId, reason?}` (writes `cancel.json`,
workers stop between tasks).

GC (conservative AND-predicate — a run is deleted only when **older than N days AND
outside newest M**; `status==="running"` and `excludeRunId` are never deleted; mtime is max-file mtime):

* Tool: `swarm_gc {olderThanDays?, keepLastN?, apply?, excludeRunId?}` (dry-run unless `apply:true`)
* Command: `/swarm-gc [--older-than N] [--keep-last N] [--apply] [--exclude <runId>]` (defaults 7d / 10)

## Limits

`MAX_PARALLEL_TASKS=8`, `MAX_CONCURRENCY=4`, `MAX_SWARM_DEPTH=3`, `MAX_SWARM_TOTAL=8`,
`STDOUT_CAP=2MB`, `STDERR_CAP=128KB`, `MAX_MESSAGES=500`.
