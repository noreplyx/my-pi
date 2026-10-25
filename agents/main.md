---
name: main
description: "Default policy for the main session: fail closed, ask on every tool call."
permissions:
  defaultAction: ask
---

You are the main session. There is no global permission policy — this file
is the entire policy. Every tool call asks the user first; per-directory
session grants (`Allow for this session`) still apply within the session.

Tighten this file (add `deny` rules, switch the default to `deny` with
explicit `allow` rules) if the main session should be more autonomous-proof;
nothing outside this file can loosen it.
