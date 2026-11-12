# LSP Extension

Code intelligence for **C#**, **Python**, **TypeScript**, **JavaScript**, **Bash**, **Shell (`sh`/`zsh`)**, **Lua**, and **PowerShell** via stdio language servers. No new npm dependencies — only `node:child_process` + JSON-RPC framing.

## Supported languages & defaults

| Language | File extensions / names | Default command | Default args |
| --- | --- | --- | --- |
| `csharp` | `.cs` | `csharp-language-server` | `[]` |
| `python` | `.py`, `.pyi` | `pylsp` | `[]` |
| `typescript` | `.ts`, `.tsx`, `.mts`, `.cts` | `typescript-language-server` | `["--stdio"]` |
| `javascript` | `.js`, `.jsx`, `.mjs`, `.cjs` | `typescript-language-server` | `["--stdio"]` |
| `bash` | `.bash`, `.bashrc`, `.bash_profile`, `.bash_aliases` | `bash-language-server` | `["start"]` |
| `shell` | `.sh`, `.zsh`, `.zshrc`, `.zshenv`, `.zprofile`, `.profile` | `bash-language-server` | `["start"]` |
| `lua` | `.lua` | `lua-language-server` | `[]` |
| `powershell` | `.ps1`, `.psm1`, `.psd1` | `powershell-editor-services` | `["-Stdio"]` |

## Install language servers

```sh
# C# — primary: standalone binary from razzmatazz releases
# 1. Download the per-OS asset from
#    https://github.com/razzmatazz/csharp-language-server/releases
# 2. chmod +x csharp-language-server && put it on PATH as csharp-language-server
# The dotnet-tool install route (`dotnet tool install -g csharp-language-server`)
# is unreliable / delisted — do not use it.

# C# — alternative: OmniSharp (download from
# https://github.com/OmniSharp/omnisharp-roslyn/releases and run with -lsp)
# Configure via lsp.json:
# { "servers": { "csharp": { "command": "OmniSharp", "args": ["-lsp"] } } }

# Python
pipx install python-lsp-server
# alt: npm i -g pyright && pyright-langserver --stdio

# TypeScript / JavaScript
npm i -g typescript-language-server typescript

# Bash / Shell (sh, bash, zsh)
npm i -g bash-language-server
# optional: install shellcheck and shfmt on PATH for richer diagnostics/formatting

# Lua
# Download from https://github.com/LuaLS/lua-language-server/releases
# or on Windows with Neovim Mason installed, `%LOCALAPPDATA%\nvim-data\mason\bin`
# (and `mason\packages\lua-language-server\bin`) is searched automatically as a fallback.

# PowerShell
# Download PowerShellEditorServices from https://github.com/PowerShell/PowerShellEditorServices/releases
# and expose a `powershell-editor-services` wrapper on PATH (supporting `-Stdio`).
```

Verify: `csharp-language-server --version`, `pylsp --version`, `typescript-language-server --version`, `bash-language-server --version`, `lua-language-server --version`.

## Configure

Copy `lsp.json.example` to either location (project wins):

- `<extension-dir>/lsp.json` (beside `index.ts`)
- `<cwd>/.pi/lsp.json`

Shape: `{ autoStart?, servers: { csharp: { command, args, rootMarkers, enabled }, python: {...}, typescript: {...}, javascript: {...}, bash: {...}, shell: {...}, lua: {...}, powershell: {...} } }`.
Binaries are resolved on `PATH` (plus `%LOCALAPPDATA%\nvim-data\mason` fallback on Windows, with automatic `.exe`/`.cmd`/`.bat` resolution); missing ones produce fail-closed `isError` messages with the install hint above — never a throw.

## Use

```sh
pi --extension ~/.pi/agent/extensions/lsp
# inside pi:
/lsp-status    # stopped until first tool use (lazy per language+root)
/lsp-restart [csharp|python|typescript|javascript|bash|shell|lua|powershell]
/lsp-stop
```

Tools (all `readOnlyHint`, 1-based lines/columns, file auto-opened before query):

- `lsp_hover { language, file, line, character }`
- `lsp_definition { language, file, line, character }`
- `lsp_references { language, file, line, character, includeDeclaration? }`
- `lsp_diagnostics { language, file? }`
- `lsp_document_symbols { language, file }`
- `lsp_workspace_symbols { language, query }`

Results are truncated at 50 items / 8000 chars and carry both human `content` and `structuredContent` (`{ uri, path, line, character }` 1-based).
`AbortSignal` cancels in-flight requests; shutdown is idempotent (`SIGTERM` → `SIGKILL`).

Root detection walks up from the file: `*.sln`/`*.csproj`, `pyproject.toml`/`requirements.txt`, `tsconfig.json`/`package.json`.

Works in print/RPC/JSON modes (no TUI dependency); `/lsp-status` uses `notify`, TUI status line only when `ctx.mode === "tui"`.
