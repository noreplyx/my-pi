/**
 * Strict validator for spec markdown.
 *
 * Must (error): summary, >=1 explanation ##, acceptance criteria,
 * all three mermaid diagrams (flowchart, ER, usecase), test cases table,
 * conditional HTTP / non-HTTP tables, pros/cons table.
 * Optional (warning): citations content, [[wikilinks]], non-TODO leftovers.
 */

import type { SpecKind } from "./template.ts";

export interface ValidationResult {
	ok: boolean;
	missing: string[];
	warnings: string[];
}

const FIXED_SECTIONS = new Set([
	"summary",
	"acceptance criteria",
	"flow diagrams",
	"flowchart",
	"er diagram",
	"usecase diagram",
	"use-case diagram",
	"use case diagram",
	"test cases",
	"api — http",
	"api - http",
	"api — non-http",
	"api - non-http",
	"pros / cons",
	"pros/cons",
	"citations",
	"related",
]);

function headings(md: string): { level: number; text: string }[] {
	const out: { level: number; text: string }[] = [];
	for (const line of md.split("\n")) {
		const m = /^(#{1,3})\s+(.+?)\s*$/.exec(line.trim());
		if (m) out.push({ level: m[1].length, text: m[2].trim() });
	}
	return out;
}

function sectionBody(md: string, heading: string): string {
	const lines = md.split("\n");
	const idx = lines.findIndex(
		(l) => /^#{1,3}\s+/.test(l.trim()) && l.replace(/^#{1,3}\s+/, "").trim().toLowerCase() === heading.toLowerCase(),
	);
	if (idx === -1) return "";
	let end = lines.length;
	for (let i = idx + 1; i < lines.length; i++) {
		if (/^#{1,2}\s+/.test(lines[i].trim())) {
			end = i;
			break;
		}
	}
	return lines.slice(idx + 1, end).join("\n");
}

function hasTableWith(body: string, needles: string[]): boolean {
	const rows = body.split("\n").filter((l) => l.trim().startsWith("|"));
	if (rows.length < 2) return false;
	const head = rows[0].toLowerCase();
	return needles.every((n) => head.includes(n.toLowerCase()));
}

function mermaidBlocks(md: string): string[] {
	const blocks: string[] = [];
	const re = /```mermaid\s*\n([\s\S]*?)```/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(md)) !== null) blocks.push(m[1]);
	return blocks;
}

export function validateSpecMarkdown(md: string, kind: SpecKind = "mixed"): ValidationResult {
	const missing: string[] = [];
	const warnings: string[] = [];
	const hs = headings(md);
	const h2 = hs.filter((h) => h.level === 2).map((h) => h.text.toLowerCase());

	if (!h2.includes("summary") || !sectionBody(md, "Summary").trim()) {
		missing.push("summary (## Summary with content)");
	}

	const explanations = hs.filter((h) => h.level === 2 && !FIXED_SECTIONS.has(h.text.toLowerCase()));
	if (explanations.length < 1 || !explanations.some((h) => sectionBody(md, h.text).trim())) {
		missing.push("explanation (≥1 ## section beyond the fixed template sections, with content)");
	}

	const acc = sectionBody(md, "Acceptance Criteria");
	if (!h2.includes("acceptance criteria") || !acc.trim()) {
		missing.push("acceptance criteria (## Acceptance Criteria with items)");
	} else if (!/[-*]\s+(\[.?\]\s+)?\S/.test(acc)) {
		missing.push("acceptance criteria (at least one list item)");
	}

	// Flow diagrams — strict: all three.
	// Flow diagrams — strict: all three. A usecase block (actor/usecase
	// markers) does not count as the flowchart even when drawn with
	// flowchart syntax (mermaid has no native usecase type).
	const isUseBlock = (b: string) => /actor|usecase|use-case|use case/i.test(b) || /UC\d|\(\(/.test(b);
	const blocks = mermaidBlocks(md);
	const hasFlow = blocks.some((b) => !isUseBlock(b) && /flowchart|graph\s+(TD|LR|TB|BT)/i.test(b));
	const hasER = blocks.some((b) => /erDiagram/i.test(b));
	const hasUse = blocks.some(isUseBlock);
	if (!blocks.length) {
		missing.push("flow diagrams (no ```mermaid blocks found)");
	} else {
		if (!hasFlow) missing.push("flow diagram: flowchart (```mermaid flowchart TD/LR)");
		if (!hasER) missing.push("flow diagram: ER (```mermaid erDiagram)");
		if (!hasUse) missing.push("flow diagram: usecase (mermaid with actor/usecase)");
	}

	const tests = sectionBody(md, "Test Cases");
	if (!h2.includes("test cases") || !hasTableWith(tests, ["id", "case"]) || !/expected/i.test(tests)) {
		missing.push("test cases (## Test Cases table with ID | Case | Steps | Expected)");
	}

	if (kind === "http" || kind === "mixed") {
		const api = sectionBody(md, "API — HTTP") || sectionBody(md, "API - HTTP");
		if (!api || !hasTableWith(api, ["case name", "method"]) || !/path/i.test(api)) {
			missing.push("http api (## API — HTTP table with Case Name | Method | Path | Request | Response)");
		}
	}
	if (kind === "non-http" || kind === "mixed") {
		const api = sectionBody(md, "API — Non-HTTP") || sectionBody(md, "API - Non-HTTP");
		if (!api || !hasTableWith(api, ["parameter"]) || !/return/i.test(api)) {
			missing.push("non-http api (## API — Non-HTTP table with Function | Parameters | Returns)");
		}
	}

	const pc = sectionBody(md, "Pros / Cons") || sectionBody(md, "Pros/Cons");
	if (!pc || !hasTableWith(pc, ["pros", "cons"])) {
		missing.push("pros/cons (## Pros / Cons table with Option | Pros | Cons)");
	}

	const cit = sectionBody(md, "Citations");
	if (!cit.trim() || /_\(optional\)_/i.test(cit)) {
		warnings.push("citations empty (optional but recommended)");
	}
	if (!/\[\[.+?\]\]/.test(md)) {
		warnings.push("no [[wikilinks]] — Obsidian graph will not connect this spec");
	}
	if (/_TODO_/i.test(md)) {
		warnings.push("contains _TODO_ placeholders");
	}

	return { ok: missing.length === 0, missing, warnings };
}
