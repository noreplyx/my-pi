---
name: main
description: "Default policy for the main session: fail closed, ask on every tool call."
permissions:
  defaultAction: ask
  rules:
    - { tool: git-tool, match: 're:"op"\s*:\s*"(status|diff|log|show|branch-list|remote-list|stash-list|tag-list|worktree-list)"', action: allow }
    - { tool: git-tool, action: deny }
    - { tool: bash, match: "re:^git\\s+(blame|shortlog|describe|rev-parse|rev-list|ls-files|ls-tree|cat-file|for-each-ref|reflog|whatchanged|var)\\b[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^git\\s+remote\\s+(show|get-url)\\b[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^git\\s+stash\\s+show\\b[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^git\\s+submodule\\s+status\\b[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^git\\s+config\\s+(--(global|system|local|worktree)\\s+)?(--get(-all|-regexp)?|--list|-l)\\b[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^git\\s+(version|help|--version|--help|-v|-h)\\b[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^git\\b", action: deny }
    - { tool: bash, match: "re:^dotnet\\s+((build|test|run|clean|restore|format|vstest|list)\\b|--(info|version|help)\\b)[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^(npm|pnpm)\\s+((test|run(-script)?|exec|ls|list)\\b|--version\\b)[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^bun\\s+((test|run|build|check|x)\\b|--version\\b)[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^node\\s+(--experimental-strip-types\\s+)?(-c|--check)\\b[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^go\\s+((build|test|vet|fmt|run|list)\\b|version\\b)[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^cargo\\s+((check|build|test|clippy|fmt)\\b|--version\\b)[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^python3?\\s+--version[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^python3?\\s+-m\\s+(pytest|unittest|mypy|pyright|ruff|black|flake8|py_compile|compileall)\\b[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^python3?\\s+[^;&|$`<>\\n]*\\.py\\b[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^(pytest|ruff|mypy|pyright|black|flake8)\\b[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^pip3?\\s+(list|show|check|freeze)\\b[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^uv\\s+((run|test)\\b|--version\\b)[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^(eslint|biome|tsc|pyright)\\b[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^(npx|bunx)\\s+((eslint|biome|tsc|pyright)\\b|--version\\b)[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^(pwsh|powershell)(\\.exe)?\\s+(--version|--help|-v|-h|-Version|-Help)\\b[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^(pwsh|powershell)(\\.exe)?\\s+(-(NoLogo|NoProfile|NonInteractive|NoP|NonI)\\s+)*-(Command|c)\\s+[\"']?\\s*(Get-(Command|ChildItem|Content|Item|ItemProperty|Location|Process|Service|CimInstance|Date|FileHash)|Select-(String|Object)|Test-Path|Resolve-Path|Measure-Object|Where-Object)\\b[^;&|$`<>\\n]*$", action: allow }
    - { tool: sql_reader, action: allow }
    - { tool: "re:^lsp_(diagnostics|definition|references|hover|document_symbols|workspace_symbols)$", action: allow }
    - { tool: fetch, match: 're:^(POST|PUT|PATCH|DELETE)\b', action: ask }
    - { tool: fetch, match: 're:"allowPrivateNetwork"\s*:\s*true', action: ask }
    - { tool: fetch, match: 're:"rejectUnauthorized"\s*:\s*false', action: ask }
    - { tool: fetch, action: allow }
---

You are the main session. There is no global permission policy — this file
is the entire policy. Every tool call asks the user first; per-directory
session grants (`Allow for this session`) still apply within the session.

Tighten this file (add `deny` rules, switch the default to `deny` with
explicit `allow` rules) if the main session should be more autonomous-proof;
nothing outside this file can loosen it.

<!-- git policy (extension-first, migrated to match subagents): status/diff/log/
     show/branch via git-tool (read-ops auto-allow, all other git-tool ops
     deny); bash git is plumbing fallback only (blame/describe/rev-parse/
     ls-files/cat-file/..., remote show/get-url, stash show, submodule
     status, config get/list, version/help) with a terminal deny. No `tools:`
     allowlist here by design (main session keeps all tools available under
     ask-default, unlike subagents); git-tool is governed by the permission
     rules above. -->
