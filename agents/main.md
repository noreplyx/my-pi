---
name: main
description: "Default policy for the main session: fail closed, ask on every tool call."
permissions:
  defaultAction: ask
  rules:
    - { tool: bash, match: "re:^git\\s+(status|diff|log|show)\\b[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^dotnet\\s+((build|test|run|clean|restore|format|vstest|list)\\b|--(info|version|help)\\b)[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^(npm|pnpm)\\s+((test|run(-script)?|exec|ls|list)\\b|--version\\b)[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^bun\\s+((test|run|build|check|x)\\b|--version\\b)[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^go\\s+((build|test|vet|fmt|run|list)\\b|version\\b)[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^python3?\\s+--version[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^python3?\\s+-m\\s+(pytest|unittest|mypy|ruff|black|flake8)\\b[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^python3?\\s+[^;&|$`<>\\n]*\\.py\\b[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^(pytest|ruff|mypy|black|flake8)\\b[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^pip3?\\s+(list|show|check|freeze)\\b[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^uv\\s+((run|test)\\b|--version\\b)[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^(eslint|biome|tsc)\\b[^;&|$`<>\\n]*$", action: allow }
    - { tool: bash, match: "re:^(npx|bunx)\\s+((eslint|biome|tsc)\\b|--version\\b)[^;&|$`<>\\n]*$", action: allow }
---

You are the main session. There is no global permission policy — this file
is the entire policy. Every tool call asks the user first; per-directory
session grants (`Allow for this session`) still apply within the session.

Tighten this file (add `deny` rules, switch the default to `deny` with
explicit `allow` rules) if the main session should be more autonomous-proof;
nothing outside this file can loosen it.
