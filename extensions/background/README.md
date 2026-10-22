# Background bash extension

Async background tasks for `bash`, with an on/off toggle.

## Behavior

- `backgroundAuto: true` (settings.json) → **every** `bash` call runs detached
  and returns a job id (`bg-N`) immediately. The agent is woken with the
  result when the command exits.
- `backgroundAuto: false` (default) → `bash` runs in the foreground unless
  the model passes `background: true` or the user runs `/bg run <cmd>`.

## settings.json

Top-level boolean (user choice):

```json
{
  "backgroundAuto": false
}
```

Project `.pi/settings.json` overrides the user file when the key is present.
Alias also accepted: `{ "background": { "enabled": true } }`.

## Commands

- `/background [on|off|status] [--persist]` — flip the in-memory toggle;
  `--persist` writes `backgroundAuto` back to `~/.pi/agent/settings.json`.
- `/bg [list|log <id>|kill <id>|run <cmd>|on|off]` — inspect/control jobs.

## Tools (model-facing)

| Tool | Purpose |
|---|---|
| `bash` (override) | Same shell + `background?`, `timeout?`. Auto-backgrounds when enabled. |
| `bg_run` | Always detached, both modes. Delegates to `bash`, so `bash` permission rules apply. |
| `bg_list` | List session jobs. |
| `bg_output {id, wait?, tailBytes?}` | Status + log tail; `wait` blocks up to N sec. |
| `bg_stop {id}` | SIGTERM process group → SIGKILL after 5s. |

Logs: `~/.pi/agent/background/logs/bg-N.log` (64 MiB cap kills the job).
Completion wake: `sendUserMessage(..., {deliverAs:"steer"})` exactly once per job.
Session shutdown stops the poller; detached children keep running, handles are dropped.
