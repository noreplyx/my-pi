# Permissions extension

Enforces granular `allow | ask | deny` on every tool call via `tool_call`.
Agent-only: there is no global policy file. Each agent's policy lives in
its own `agents/<name>.md` frontmatter; the main session (no agent) is
governed by `agents/main.md`.

## Files

| File | Purpose |
|---|---|
| `agents/<name>.md` frontmatter `permissions:` | The agent's entire policy (no global fallback) |
| `agents/main.md` | Policy for the main session |
| `~/.pi/agent/permissions/audit.log` | Append-only decision log |

## Rule shape

```jsonc
{ "tool": "bash", "match": "*rm -rf*", "action": "deny" }
{ "tool": "read", "match": ["**/.env*", "**/secrets/**"], "action": "deny" }
{ "tool": "write", "action": "ask" }   // no match = all calls of that tool
```

- `tool`: exact name or `*` glob (`mcp__*`, `*`).
- `match`: string or string-array (OR). Omit = match all.
  - `*`, `**`, `?`, `[...]` → glob (`*rm -rf*`, `src/**`). For file-path
    targets single `*`/`?` stay within one path segment (`src/*` matches
    `src/a`, not `src/a/b`); for shell/JSON targets they match across `/`.
  - `re:<regex>` → regex (`re:^git\s+(status|diff)\b`) — for same-command/different-args.
    A `re:^…` prefix allow also matches `cmd; evil` — precede it with a deny
    on shell metachars (see reviewer example) or anchor with `$`.
  - `/body/flags` → regex with flags (`/^rm\s+-rf?/i`). A bare `/…/` with no
    flags and no regex syntax is treated as a path, not a regex
    (`/foo/bar/` stays a path).
  - plain text → substring (`npm publish`)
- `action`: `allow` (silent), `ask` (prompt; denied when no UI), `deny` (block).
- `ask` prompts with three choices: **Allow once** (single call),
  **Allow for this session** (remembers until the session ends), **Deny**
  (blocks this call; dismissing the dialog also denies). Every dialog title
  shows a one-line summary — `<action> <path>` with cwd-relative paths
  (`Allow write src/foo.txt?`), short `bash` commands in full
  (long multi-step lines collapse to `first-step … (+N more)`),
  `grep <path> "<pattern>"` for searches, `subagent <agent>
  "<task…>"` (or `chain (n steps)` / `parallel (n tasks)`) for delegated work, and `key=value` pairs for anything else. Titles are capped
  (~140 chars). Home directories shorten to `~` (display only). Full targets stay in the audit log and
  `/permissions-check`, and the shown title is audit-logged on every
  user decision. For file tools
  (`read`/`write`/`edit`/`ls`/`find`/`grep`) one session approval covers
  the whole directory — sibling files and subdirectories (recursive down,
  never up: a grant on a child never covers its parent). `bash` and other
  tools remember the exact call only. Session grants are in-memory only and
  are cleared on session shutdown/reload.

Targets: `bash`/`powershell` → `command`; `read`/`write`/`edit`/`ls` → path
(abs + cwd-relative both tried); `find`/`grep` → `path:pattern` + each part;
everything else (incl. `subagent`, MCP tools) → JSON args.

Evaluation (first applicable wins, agent-only):

1. agent rules in order
2. agent `defaultAction` (only when the file sets one)
3. hardcoded fallback `ask`

There is no global layer, so nothing outside the agent's own file can
loosen or tighten its policy. Broken regexes fail closed at runtime
(deny blocks, allow/ask never matches) and are reported at startup
(R1) — they never crash.

Parent vs child (subagent): the parent's `subagent {agent,task,…}` call is
gated by the parent agent's layer only. Inner tool calls in the child `pi`
process are gated by the target agent's layer. Use
`/permissions-check --as-agent <name> <tool> [args]` to dry-run as that
agent would see it.
`tools:` (frontmatter `--tools` allowlist) and `permissions:` both apply —
most restrictive wins.

## Per-agent config

Inline frontmatter (the entire policy for that agent):

```md
---
name: reviewer
permissions:
  defaultAction: deny
  rules:
    # Prefix allows match chained commands too — block metachars first.
    - { tool: bash, match: "re:[;&|$`<>\\n]", action: deny }
    - { tool: bash, match: "re:^git\\s+(status|diff)\\b[^;&|$`<>\\n]*$", action: allow }
    - { tool: ls, action: allow }
    - { tool: read, match: "**", action: allow }
---
```

Or external file: `permissions: ./reviewer.permissions.json`.
Agent identity reaches child `pi` processes via `PI_AGENT_NAME`/`PI_AGENT_FILE`
(injected by the `subagent` extension patch); the main session with neither
set falls back to `agents/main.md`. The `agent-switch` extension never wipes
an externally injected identity on startup/shutdown — only an in-process
`/agent` switch is reset — so children keep their target agent's layer
instead of degrading to `main.md`.

## Commands

- `/permissions-status` — agent layer, validation diagnostics, config errors, active session grants
- `/permissions-check <tool> [json-args|key=value]` — dry-run one call (add `--as-agent <name>` to evaluate as that agent)
- `/permissions-clear-session` — revoke all "Allow for this session" grants (prompts will ask again)
- `/permissions-reload` — re-read agent configs (also auto-reloads on mtime change)

> Tip: chained commands (`;`, `&&`, `||`, pipes, `&`, newlines) are split
> into quote-aware segments and evaluated independently (strict): any
> segment `deny` blocks the whole call, all segments `allow` passes
> silently, otherwise it asks. `git status && git diff` passes when both
> segments are allowed; `git status; rm -rf /tmp/x` is denied on segment 2.
> Session grants cover the whole chained command (exact match).

## Startup validation

On session `startup`/`reload`, the extension validates every agent file
declaring `permissions:` (user dir and project-local, including
`agents/main.md`), and warns once if anything is off. Clean configs stay
silent.

| Severity | Meaning |
|---|---|
| error | rule is broken: bad JSON, bad action, uncompilable `re:`/`/.../` (deny fails closed/blocking, allow/ask never matches), unreadable ref file |
| warning | suspicious but functional: unknown tool name (may just connect later), unreachable shadowed rule, allow-all (`tool: "*"` or bare `bash`), prefix-anchored shell allow without a chaining guard, empty/no-effect agent block, default-allow with no rules, missing agent file (e.g. no `main.md` — that agent falls back to `ask`) |

Shadowing is plain first-match order within each agent file.
Display: `ctx.ui.notify` in TUI/RPC, `console.warn` (stderr only) when
headless — stdout is never touched so `--mode json` stays intact.
Validation never blocks startup; broken rules are already fail-closed
at enforcement time.

Unknown-tool warnings are provisional: MCP/custom tools can register after
startup, so such a warning retracts automatically the first time its tool
is actually invoked (and stays retracted in `/permissions-status`).
