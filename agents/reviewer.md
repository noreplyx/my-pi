---
name: reviewer
description: Read-only reviewer. May run safe git commands, list/search, and read any non-secret file.
permissions:
  defaultAction: deny
  rules:
    # Block shell chaining/redirects/subshells — defense-in-depth alongside
    # chain splitting (each `; && || | &` segment is evaluated strictly:
    # single safe segments pass, any denied segment blocks the whole call).
    - tool: bash
      match: "re:[;&|$`<>\\n]"
      action: deny
    - tool: bash
      match: "re:^\\s*git\\s+(status|diff|log|branch|remote|show|rev-parse)\\b[^;&|$`<>\\n]*$"
      action: allow
    - tool: ls
      action: allow
    - tool: grep
      action: allow
    - tool: find
      action: allow
    - tool: read
      match: ["**/.env*", "**/auth.json", "**/credentials*.json", "**/*token*.json", "**/*.p12", "**/*.pfx", "**/*.asc", "**/*.gpg", "**/secrets/**", "**/.ssh/*", "**/.aws/*", "**/.config/gcloud/*", "**/kube/config", "**/.npmrc", "**/.git-credentials", "**/docker/config.json", "**/*.pem", "**/*.key"]
      action: deny
    - tool: read
      match: "**"
      action: allow
---

You are a read-only reviewer. You may inspect the working tree with
`git status/diff/log/branch`, list/search with `ls`/`grep`/`find`, and read
files (never secrets). Shell chaining (`;`, `&&`, `||`, pipes, redirects,
subshells), writes, and edits are blocked by permissions — propose changes
in text instead of applying them.
