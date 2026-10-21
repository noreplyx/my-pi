# Swarm extension

Fan-out template over isolated subagents. One `swarm` call expands
`template × items[N]` into N prompts and runs each through the shared
`runSingleAgent` spawner from `../subagent` (same trust boundary:
minimal child env, symlink containment, project-agent approval gate,
`--model`/`--tools` validation, no recursive `swarm`/`subagent` tools).

## When to use what

| Need | Tool |
|---|---|
| One focused child | `subagent` single (`agent` + `task`) |
| Hand-built parallel batch | `subagent` parallel (`tasks[]`) |
| Sequential with `{previous}` | `subagent` chain (`chain[]`) |
| Same prompt over many items | **`swarm`** (`template` + `items[]`) |

## Parameters

```ts
{
  agent: "reviewer",                          // required
  template: "Review {item} for bugs.",        // required, must contain {item}
  items: ["src/a.ts", "src/b.ts"],            // required, 1-20
  agentScope: "user",                         // optional: user|project|both
  cwd: "subdir",                              // optional
  maxConcurrency: 4,                          // optional, 1-4
  stopOnError: false,                         // optional, v1: output-only note
}
```

Placeholders: `{item}` (required), `{index}` (1-based), `{count}`.
`$`-patterns in items pass through literally.

## Limits

| Constant | Value |
|---|---|
| `MAX_SWARM_ITEMS` | 20 |
| `MAX_SWARM_CONCURRENCY` | 4 |
| `MAX_ITEM_CHARS` | 4096 (pass a path, let the child `read` it) |
| `MAX_TEMPLATE_CHARS` | 16384 |
| `MAX_TOTAL_EXPANDED_CHARS` | 131072 |

## Trust

Same as `subagent`: project-local agents require approval
(`isProjectTrusted()` or `ui.confirm`, fail-closed headless);
child tools `swarm`/`subagent` are stripped with a warning;
per-item failures are isolated (one throw never drops the batch).

## Permissions

Generic JSON-args target already covers `swarm`. Gate fan-out with:

```jsonc
{ "tool": "swarm", "action": "ask" }
```

Dialog title: `swarm <agent> "<template…>" (N items)`.

## v1 non-goals

No mailbox / inter-agent comms, no coordinator multi-turn,
no worktree isolation. `stopOnError` is noted in the header only —
all children run to completion; partial success is not an error
(`isError` only when 0/N succeed).
