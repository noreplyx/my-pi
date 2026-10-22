# pi agent config (`~/.pi/agent`)

Personal configuration for the [pi](https://github.com/badlogic/pi-mono) coding agent.
Tracked in git; secrets and machine-local state are gitignored.

## Layout

| Path | Purpose |
|---|---|
| `settings.json` | Default provider/model, changelog version |
| `permissions.json` | Global permission policy (`allow\|ask\|deny` per tool — see `extensions/permissions/README.md`) |
| `agents/` | Per-agent frontmatter (`permissions:` beats global, including global `deny`) |
| `extensions/permissions/` | Permission enforcement extension + tests |
| `extensions/subagent/` | Subagent delegation extension (spawns isolated `pi` processes) |
| `permissions/audit.log` | Append-only permission decision log (gitignored) |
| `auth.json` | Credentials — **never committed** (gitignored) |
| `install/`, `bin/` | Managed install binaries/releases — reproducible via installer (gitignored) |
| `sessions/`, `models-store.json` | Transcripts + local cache (gitignored) |

## Workflows

- Edit policy: change `permissions.json` (JSONC comments allowed), then `/permissions-reload`.
- Inspect: `/permissions-status` (layers + diagnostics), `/permissions-check <tool> <args>` (dry-run).
- Tip: run **one command per `bash` tool call** so safe-allows (`git status`, `ls`, …) hit silently. Chained commands (`;`, `&&`, `||`, pipes) intentionally fall through to `ask` — that's the chaining guard working, not a bug.
