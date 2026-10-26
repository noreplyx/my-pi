# Spec extension

Spec-driven development with Obsidian vault support. Specs live in
`<project>/specs/*.md` — open that folder directly in Obsidian to see the
spec graph.

## Tools

| Tool | Purpose |
|---|---|
| `spec_create` | Brainstorm-gated create. First call (no `confirm`) returns a brainstorm brief and writes nothing. Re-call with `confirm:true`, `askRounds>=1`, `answersSummary`, and full fields to validate + write. |
| `spec_read` | Read a spec, optionally one `##` section. |
| `spec_edit` | Replace/append one `##` section. Saves + reports validation; rebuilds MOC. |
| `spec_delete` | Archive to `specs/_archived/<slug>-<date>.md` (default) or `hard:true` to delete. Rebuilds MOC. |
| `spec_list` | List all specs (slug, title, status, kind, updated). |

## Commands

- `/spec-create <summary>` — starts the loop: brainstorm → `ask_user` rounds → 2+ options → validated write.
- `/spec-read <slug> [--section Name]`
- `/spec-edit <slug> <## Section>`
- `/spec-delete <slug> [--hard]`
- `/spec-list`

## Create loop (enforced)

1. Model calls `spec_create { slug, summary, kind }` → gets brainstorm brief, nothing written.
2. Model brainstorms, then asks via `ask_user` (one question per call, parallel for independent ones). Loops until gaps close or are deferred.
3. Model presents 2+ options with pros/cons/risks + recommendation; user picks.
4. Model re-calls `spec_create` with `confirm:true`, `askRounds` (actual count, ≥1), `answersSummary` (user decisions), and all spec fields. The call is strictly validated and only then written to `specs/<slug>.md`, with `specs/index.md` rebuilt.

## Spec format (strict)

Required: `## Summary`, ≥1 explanation `##` section, `## Acceptance Criteria`,
`## Flow Diagrams` with **all three** mermaid blocks (`flowchart`, `erDiagram`,
usecase with `actor`/`usecase`), `## Test Cases` table
(`ID | Case | Steps | Expected`), conditional `## API — HTTP`
(`Case Name | Method | Path | Request | Response`) and/or `## API — Non-HTTP`
(`Function | Parameters | Returns`), `## Pros / Cons` table.
Optional (warns): `## Citations`. `[[wikilinks]]` in `## Related` connect the graph.

`kind` selects the API tables: `http` → HTTP only, `non-http` → params/returns
only, `mixed` → both.

## Obsidian graph

- `specs/` **is** the vault folder — no sync step.
- Every spec's `## Related` lists `[[slug]]` wikilinks (from `related` + body links).
- `specs/index.md` is the MOC hub: table of all specs + a `## Graph` link line.
  Rebuilt on every create/edit/delete; manual intro above
  `<!-- spec-index:auto -->` is preserved. Graph View shows index-hub + peer edges.

## Layout

| File | Contents |
|---|---|
| `index.ts` | Tool + command wiring only |
| `template.ts` | `buildSpecMarkdown`, `slugify`, placeholder spec |
| `validate.ts` | Strict section/diagram/table checker |
| `graph.ts` | `specs/` paths, `[[wikilink]]` extraction, MOC rebuild |
| `workflow.ts` | Brainstorm brief, loop-receipt check, `/spec-create` instruction |
| `validate.test.ts`, `graph.test.ts` | `bun test` coverage |
