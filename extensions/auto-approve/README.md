# Auto-approve extension

Session-only toggle that auto-allows permission `ask` prompts. Explicit
`deny` rules **still block** — the toggle never bypasses `deny`.

## Commands

- `/auto-approve on` — auto-allow every `ask` (no dialogs). Conspicuous
  `warning` notify + `auto-approve:ON` in the status bar.
- `/auto-approve off` — back to prompting (default).
- `/auto-approve` or `/auto-approve status` — show current state.

Aliases: `enable`/`disable` work like `on`/`off`.

## Safety

- Default OFF. Stored in `process.env` (`PI_AUTO_APPROVE=1`) — per-process,
  never written to disk. Why env and not a module variable: each extension
  file is loaded through its own module instance (loader uses jiti with
  `moduleCache: false`), so a `let enabled` singleton would exist once per
  importing extension and the toggle would never be seen by the enforcer.
- Cleared on `session_start` (any reason: startup/reload/new/resume/fork)
  and `session_shutdown` — a new main session always starts prompting.
  Exception: a subagent child process spawned while the parent toggle is ON
  inherits it via `PI_AUTO_APPROVE=1` (set per-spawn by the parent, never
  from repo-controlled config), so delegated work doesn't re-prompt.
  Grandchildren inherit transitively through the same mechanism.
- Explicit `deny` rules still block everywhere, including inherited children.
- Headless runs (`--mode json`, no UI) are also auto-allowed when ON
  (normally `ask` without UI denies). Prefer OFF for unattended runs.

## How it works

State lives in `state.ts` (`isAutoApproveEnabled()`), shared pi-free so
there is no import cycle. Enforcement is a short-circuit in the
`permissions` extension's `tool_call` handler: after the `deny` branch,
before session-grant/dialog code:

```ts
if (isAutoApproveEnabled()) {
  void audit("allow", event.toolName, result.target, `via=auto-approve ${where}`);
  return undefined;
}
```

Every auto-approved call is audit-logged (`via=auto-approve`) to
`permissions/audit.log`, and `/permissions-status` shows the toggle state.
