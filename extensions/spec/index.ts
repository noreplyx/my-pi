/**
 * Spec extension — spec-driven development with Obsidian vault support.
 *
 * Per-project `specs/` folder (open it directly in Obsidian):
 *  - Markdown specs with strict sections + 3 mermaid diagrams.
 *  - [[wikilinks]] + auto-rebuilt `specs/index.md` MOC for Graph View.
 *
 * Tools: spec_create (ask-loop enforced), spec_read, spec_edit,
 * spec_delete, spec_list.
 * Commands: /spec-create, /spec-read, /spec-edit, /spec-delete, /spec-list.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ensureSpecsDir, listSpecs, rebuildIndex, specPath } from "./graph.ts";
import { buildSpecMarkdown, slugify, type SpecFields } from "./template.ts";
import { validateSpecMarkdown } from "./validate.ts";
import { brainstormBrief, checkLoopReceipt, CREATE_INSTRUCTION } from "./workflow.ts";

const Kind = Type.Union([Type.Literal("http"), Type.Literal("non-http"), Type.Literal("mixed")], {
	description: 'Spec kind: "http" (request/response API), "non-http" (function/library params+returns), or "mixed" (both tables).',
});

const ExplanationItem = Type.Object({
	heading: Type.String({ description: "Section heading (e.g. Background, Design)" }),
	body: Type.String({ description: "Section body markdown" }),
});

const SpecCreateParams = Type.Object({
	slug: Type.String({ description: "Spec slug, becomes specs/<slug>.md (auto-slugified)" }),
	summary: Type.String({ description: "One-paragraph summary of what the user wants (required)" }),
	kind: Type.Optional(Kind),
	explanations: Type.Optional(Type.Array(ExplanationItem, { description: "Explanation sections 2..N (>=1 required to write)" })),
	acceptance: Type.Optional(Type.Array(Type.String(), { description: "Acceptance criteria items" })),
	httpRows: Type.Optional(
		Type.Array(
			Type.Object({
				caseName: Type.String(),
				method: Type.String(),
				path: Type.String(),
				request: Type.String(),
				response: Type.String(),
			}),
		),
	),
	nonHttpRows: Type.Optional(
		Type.Array(
			Type.Object({ name: Type.String(), parameters: Type.String(), returns: Type.String() }),
			{ description: "Function/parameter/return rows (non-http|mixed)" },
		),
	),
	testCases: Type.Optional(
		Type.Array(
			Type.Object({ id: Type.String(), case: Type.String(), steps: Type.String(), expected: Type.String() }),
		),
	),
	prosCons: Type.Optional(
		Type.Array(Type.Object({ option: Type.String(), pros: Type.String(), cons: Type.String() })),
	),
	citations: Type.Optional(Type.Array(Type.String())),
	related: Type.Optional(Type.Array(Type.String(), { description: "Related spec slugs — become [[wikilinks]]" })),
	overwrite: Type.Optional(Type.Boolean({ description: "Overwrite specs/<slug>.md if it exists (default false)" })),
	confirm: Type.Optional(Type.Boolean({ description: "Must be true to write. Omit/false returns the brainstorm brief instead." })),
	askRounds: Type.Optional(
		Type.Integer({ description: "Number of ask_user Q&A rounds actually completed (required when confirm:true, >=1)" }),
	),
	answersSummary: Type.Optional(
		Type.String({ description: "What the user decided in the ask loop (required when confirm:true)" }),
	),
});

type CreateParams = typeof SpecCreateParams.static;

function ok(text: string, details?: unknown, structuredContent?: unknown) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		...(structuredContent !== undefined ? { structuredContent } : {}),
	};
}

function fail(text: string, details?: unknown) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		isError: true,
	};
}

function kindOf(params: CreateParams): SpecFields["kind"] {
	return (params.kind as SpecFields["kind"]) ?? "mixed";
}

function toFields(p: CreateParams): SpecFields {
	return {
		slug: slugify(p.slug),
		title: slugify(p.slug),
		status: "confirmed",
		summary: p.summary,
		explanations: (p.explanations ?? []).map((e) => ({ heading: e.heading, body: e.body })),
		acceptance: p.acceptance ?? [],
		kind: kindOf(p),
		httpRows: p.httpRows,
		nonHttpRows: p.nonHttpRows,
		testCases: (p.testCases ?? []).map((t) => ({ id: t.id, case: t.case, steps: t.steps, expected: t.expected })),
		prosCons: (p.prosCons ?? []).map((r) => ({ option: r.option, pros: r.pros, cons: r.cons })),
		citations: p.citations,
		related: p.related,
	};
}

function extractSection(md: string, section: string): string | null {
	const lines = md.split("\n");
	const norm = section.trim().toLowerCase();
	const idx = lines.findIndex((l) => {
		const m = /^#{1,3}\s+(.+?)\s*$/.exec(l.trim());
		return m !== null && m[1].trim().toLowerCase() === norm;
	});
	if (idx === -1) return null;
	let end = lines.length;
	const level = /^#{1,3}/.exec(lines[idx].trim())![0].length;
	for (let i = idx + 1; i < lines.length; i++) {
		const m = /^(#{1,3})\s+/.exec(lines[i].trim());
		if (m && m[1].length <= level) {
			end = i;
			break;
		}
	}
	return lines.slice(idx, end).join("\n").trim();
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "spec_create",
		label: "Spec Create",
		description: [
			"Create an Obsidian-compatible spec in <project>/specs/<slug>.md.",
			"ASK-LOOP ENFORCED: call WITHOUT confirm first (or confirm:false) to get the brainstorm brief;",
			"then ask the user via ask_user (one question per call, loop until gaps close), present 2+ options with pros/cons/risks,",
			"then re-call WITH confirm:true, askRounds>=1, answersSummary, and the full spec fields.",
			"Nothing is written until the confirming call passes strict validation:",
			"summary, >=1 explanation section, acceptance criteria, ALL THREE mermaid diagrams (flowchart, erDiagram, usecase),",
			"test-case table, conditional HTTP request/response/case-name table and/or non-HTTP parameter/return table, pros/cons table.",
			"Writes also rebuild specs/index.md (MOC) for the Obsidian graph.",
		].join(" "),
		parameters: SpecCreateParams,
		promptSnippet: "spec_create(slug, summary, kind) — brainstorm-gated spec writer",
		promptGuidelines: [
			"Never call spec_create with confirm:true on the first call — brainstorm and ask the user first.",
			"askRounds must equal the ask_user rounds you actually ran (>=1); answersSummary must state user decisions.",
			"Fill every strict section; include all three mermaid diagrams (flowchart, erDiagram, usecase).",
		],
		async execute(_id, raw, _signal, _onUpdate, ctx) {
			const params = raw as CreateParams;
			const cwd = (ctx as unknown as { cwd: string }).cwd ?? process.cwd();
			const slug = slugify(params.slug || "spec");
			const kind = kindOf(params);

			if (!params.confirm) {
				const brief = brainstormBrief(params.summary ?? "", kind);
				return ok(brief.message + `\n\nSuggested questions:\n${brief.suggestedQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`, {
					phase: brief.phase,
					slug,
					kind,
				});
			}

			const receiptErr = checkLoopReceipt(params);
			if (receiptErr) {
				return fail(
					`spec_create refused: ${receiptErr}\nRun the ask loop first (ask_user rounds), then confirm with askRounds>=1 and answersSummary.`,
					{ slug, kind },
				);
			}

			const md = buildSpecMarkdown(toFields({ ...params, slug }));
			const v = validateSpecMarkdown(md, kind);
			if (!v.ok) {
				return fail(
					`spec_create refused: strict validation failed:\n${v.missing.map((m) => `- ${m}`).join("\n")}\nFill the missing sections and re-call with confirm:true.`,
					{ slug, kind, missing: v.missing, warnings: v.warnings },
				);
			}

			ensureSpecsDir(cwd);
			const dest = specPath(cwd, slug);
			if (fs.existsSync(dest) && !params.overwrite) {
				return fail(`spec_create refused: ${dest} exists. Pass overwrite:true to replace it.`, { slug, dest });
			}
			fs.writeFileSync(dest, md);
			const indexPath = rebuildIndex(cwd);
			const warn = v.warnings.length > 0 ? `\nWarnings:\n${v.warnings.map((w) => `- ${w}`).join("\n")}` : "";
			return ok(`Created specs/${slug}.md (${kind}) after ${params.askRounds} ask round(s). MOC rebuilt: ${path.relative(cwd, indexPath)}.${warn}`, {
				slug,
				dest,
				kind,
				askRounds: params.askRounds,
				warnings: v.warnings,
			});
		},
	} as never);

	pi.registerTool({
		name: "spec_read",
		label: "Spec Read",
		description: "Read a spec from specs/<slug>.md. Pass section (e.g. 'Summary', 'Flow Diagrams') to return just that section.",
		parameters: Type.Object({
			slug: Type.String({ description: "Spec slug" }),
			section: Type.Optional(Type.String({ description: "## heading to extract (case-insensitive)" })),
		}),
		async execute(_id, raw, _signal, _onUpdate, ctx) {
			const params = raw as { slug: string; section?: string };
			const cwd = (ctx as unknown as { cwd: string }).cwd ?? process.cwd();
			const dest = specPath(cwd, params.slug);
			if (!fs.existsSync(dest)) return fail(`spec_read: specs/${slugify(params.slug)}.md not found.`, { slug: params.slug });
			const md = fs.readFileSync(dest, "utf8");
			if (params.section) {
				const part = extractSection(md, params.section);
				if (part === null) return fail(`spec_read: section "${params.section}" not found in ${params.slug}.`, { slug: params.slug });
				return ok(part, { slug: params.slug, section: params.section });
			}
			return ok(md, { slug: params.slug });
		},
	} as never);

	pi.registerTool({
		name: "spec_edit",
		label: "Spec Edit",
		description: [
			"Edit one ## section of specs/<slug>.md (replace or append).",
			"Section is a ## heading (e.g. 'Acceptance Criteria', 'Related').",
			"Saves even if validation warns, but reports missing strict sections so the model can fix them.",
			"Appending to Related with [[wikilinks]] connects the Obsidian graph. Rebuilds the MOC.",
		].join(" "),
		parameters: Type.Object({
			slug: Type.String({ description: "Spec slug" }),
			section: Type.String({ description: "## heading to edit (case-insensitive)" }),
			content: Type.String({ description: "New markdown for the section body (heading line itself is kept)" }),
			mode: Type.Optional(Type.Union([Type.Literal("replace"), Type.Literal("append")], { description: "replace (default) or append" })),
		}),
		async execute(_id, raw, _signal, _onUpdate, ctx) {
			const params = raw as { slug: string; section: string; content: string; mode?: "replace" | "append" };
			const cwd = (ctx as unknown as { cwd: string }).cwd ?? process.cwd();
			const dest = specPath(cwd, params.slug);
			if (!fs.existsSync(dest)) return fail(`spec_edit: specs/${slugify(params.slug)}.md not found.`, { slug: params.slug });
			const md = fs.readFileSync(dest, "utf8");
			const lines = md.split("\n");
			const norm = params.section.trim().toLowerCase();
			const idx = lines.findIndex((l) => {
				const m = /^##\s+(.+?)\s*$/.exec(l.trim());
				return m !== null && m[1].trim().toLowerCase() === norm;
			});
			if (idx === -1) return fail(`spec_edit: ## ${params.section} not found. Existing ## headings: ${lines.filter((l) => /^##\s+/.test(l.trim())).join(" | ")}`, { slug: params.slug });
			let end = lines.length;
			for (let i = idx + 1; i < lines.length; i++) {
				if (/^##\s+/.test(lines[i].trim())) {
					end = i;
					break;
				}
			}
			const body = params.mode === "append"
				? lines.slice(idx + 1, end).join("\n").trimEnd() + "\n" + params.content.trim() + "\n"
				: params.content.trim() + "\n";
			const next = [...lines.slice(0, idx + 1), "", body, ...lines.slice(end)].join("\n");
			const kindMatch = /^kind:\s*(http|non-http|mixed)/m.exec(next);
			const kind = ((kindMatch?.[1] ?? "mixed") as SpecFields["kind"]);
			const v = validateSpecMarkdown(next, kind);
			const stamped = next.replace(/^updated:\s*.*$/m, `updated: ${new Date().toISOString().slice(0, 10)}`);
			fs.writeFileSync(dest, stamped);
			rebuildIndex(cwd);
			const status = v.ok ? "valid" : `INVALID — missing: ${v.missing.join("; ")}`;
			const warn = v.warnings.length > 0 ? ` Warnings: ${v.warnings.join("; ")}` : "";
			return ok(`Edited specs/${slugify(params.slug)}.md ## ${params.section} (${params.mode ?? "replace"}). Validation: ${status}.${warn}`, {
				slug: params.slug,
				section: params.section,
				validation: v,
			});
		},
	} as never);

	pi.registerTool({
		name: "spec_delete",
		label: "Spec Delete",
		description: "Delete specs/<slug>.md. Default archives to specs/_archived/<slug>-<date>.md; pass hard:true to permanently delete. Rebuilds the MOC.",
		parameters: Type.Object({
			slug: Type.String({ description: "Spec slug" }),
			hard: Type.Optional(Type.Boolean({ description: "Permanently delete instead of archiving (default false)" })),
		}),
		async execute(_id, raw, _signal, _onUpdate, ctx) {
			const params = raw as { slug: string; hard?: boolean };
			const cwd = (ctx as unknown as { cwd: string }).cwd ?? process.cwd();
			const dest = specPath(cwd, params.slug);
			if (!fs.existsSync(dest)) return fail(`spec_delete: specs/${slugify(params.slug)}.md not found.`, { slug: params.slug });
			if (params.hard) {
				fs.rmSync(dest);
				rebuildIndex(cwd);
				return ok(`Deleted specs/${slugify(params.slug)}.md permanently. MOC rebuilt.`, { slug: params.slug, hard: true });
			}
			const dir = ensureSpecsDir(cwd);
			const stamp = new Date().toISOString().slice(0, 10);
			const archived = path.join(dir, "_archived", `${slugify(params.slug)}-${stamp}.md`);
			fs.renameSync(dest, archived);
			rebuildIndex(cwd);
			return ok(`Archived specs/${slugify(params.slug)}.md → ${path.relative(cwd, archived)}. MOC rebuilt.`, {
				slug: params.slug,
				archived,
			});
		},
	} as never);

	pi.registerTool({
		name: "spec_list",
		label: "Spec List",
		description: "List specs in <project>/specs/ (slug, title, status, kind, updated). Feeds the MOC and Obsidian graph review.",
		parameters: Type.Object({}),
		async execute(_id, _raw, _signal, _onUpdate, ctx) {
			const cwd = (ctx as unknown as { cwd: string }).cwd ?? process.cwd();
			const specs = listSpecs(cwd);
			if (specs.length === 0) return ok("No specs yet. Create one with spec_create or /spec-create.", { count: 0 });
			const text = specs.map((s) => `- [[${s.slug}]] — ${s.title} [${s.status}/${s.kind}] ${s.updated}`).join("\n");
			return ok(`Specs (${specs.length}):\n${text}`, { count: specs.length, specs });
		},
	} as never);

	pi.registerCommand("spec-create", {
		description: "Create a spec via brainstorm → ask-user loop → validated write (/spec-create <summary>)",
		handler: async (args, ctx) => {
			const summary = (args ?? "").trim();
			if (!summary) {
				ctx.ui.notify("Usage: /spec-create <what you want, e.g. 'JWT auth for the API (http)'>", "warning");
				return;
			}
			pi.sendUserMessage(CREATE_INSTRUCTION(summary));
		},
	});

	pi.registerCommand("spec-read", {
		description: "Read a spec (/spec-read <slug> [--section Name])",
		handler: async (args, ctx) => {
			const m = /^\s*(\S+)(?:\s+--section\s+(.+))?\s*$/.exec(args ?? "");
			if (!m) {
				ctx.ui.notify("Usage: /spec-read <slug> [--section Name]", "warning");
				return;
			}
			const dest = specPath(ctx.cwd, m[1]);
			if (!fs.existsSync(dest)) {
				ctx.ui.notify(`spec not found: specs/${slugify(m[1])}.md`, "error");
				return;
			}
			const md = fs.readFileSync(dest, "utf8");
			const out = m[2] ? (extractSection(md, m[2]) ?? `Section "${m[2]}" not found.`) : md;
			ctx.ui.notify(out.slice(0, 6000) + (out.length > 6000 ? "\n…(truncated — use spec_read tool for full text)" : ""), "info");
		},
	});

	pi.registerCommand("spec-edit", {
		description: "Edit a spec section (/spec-edit <slug> <## Section> — model applies the change via spec_edit)",
		handler: async (args, ctx) => {
			if (!(args ?? "").trim()) {
				ctx.ui.notify("Usage: /spec-edit <slug> <## Section>", "warning");
				return;
			}
			pi.sendUserMessage(
				`SPEC EDIT — "${args.trim()}". Read the target section with spec_read, ask the user for the new content if it is not already clear (ask_user), then apply with spec_edit and report the post-edit validation.`,
			);
		},
	});

	pi.registerCommand("spec-delete", {
		description: "Archive (default) or hard-delete a spec (/spec-delete <slug> [--hard])",
		handler: async (args, ctx) => {
			if (!(args ?? "").trim()) {
				ctx.ui.notify("Usage: /spec-delete <slug> [--hard]", "warning");
				return;
			}
			pi.sendUserMessage(
				`SPEC DELETE — "${args.trim()}". Confirm with the user first (ask_user or confirm dialog), then call spec_delete (hard:true only when --hard was passed) and report the rebuilt MOC.`,
			);
		},
	});

	pi.registerCommand("spec-list", {
		description: "List all specs in specs/ with status",
		handler: async (_args, ctx) => {
			const specs = listSpecs(ctx.cwd);
			if (specs.length === 0) {
				ctx.ui.notify("No specs yet. Create one with /spec-create <summary>.", "info");
				return;
			}
			ctx.ui.notify(
				specs.map((s) => `- [[${s.slug}]] — ${s.title} [${s.status}/${s.kind}] ${s.updated}`).join("\n"),
				"info",
			);
		},
	});
}
