/**
 * Spec markdown template — Obsidian-compatible, per-project `specs/` folder.
 *
 * Required sections (strict):
 *  1. Summary (must)
 *  2. Explanation sections 2..N (must, >=1 `##` beyond the fixed ones)
 *  3. Acceptance criteria (must)
 *  4. Flow diagrams: flowchart + ER + usecase mermaid blocks (must, all three)
 *  5. Test cases (must)
 *  6. HTTP: request/response/case-name table (must when kind=http|mixed)
 *  7. Non-HTTP: parameter/return table (must when kind=non-http|mixed)
 *  8. Pros/cons (must)
 *  9. Citations / related incl. [[wikilinks]] (optional, warns when absent)
 */

export type SpecKind = "http" | "non-http" | "mixed";
export type SpecStatus = "draft" | "confirmed" | "implemented";

export interface ExplanationSection {
	heading: string;
	body: string;
}

export interface HttpRow {
	caseName: string;
	method: string;
	path: string;
	request: string;
	response: string;
}

export interface NonHttpRow {
	name: string;
	parameters: string;
	returns: string;
}

export interface TestRow {
	id: string;
	case: string;
	steps: string;
	expected: string;
}

export interface ProsConsRow {
	option: string;
	pros: string;
	cons: string;
}

export interface SpecFields {
	slug: string;
	title: string;
	status?: SpecStatus;
	summary: string;
	explanations: ExplanationSection[];
	acceptance: string[];
	kind: SpecKind;
	httpRows?: HttpRow[];
	nonHttpRows?: NonHttpRow[];
	testCases: TestRow[];
	prosCons: ProsConsRow[];
	citations?: string[];
	related?: string[];
}

export function slugify(input: string): string {
	return input
		.trim()
		.toLowerCase()
		.replace(/\.md$/i, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80) || "spec";
}

export function todayISO(): string {
	return new Date().toISOString().slice(0, 10);
}

export const FLOWCHART_STUB = `flowchart TD
    A[Request] --> B{Validate}
    B -->|ok| C[Execute]
    B -->|fail| D[Reject]
    C --> E[Respond]`;

export const ER_STUB = `erDiagram
    SPEC ||--o{ SECTION : contains
    SECTION ||--o{ TEST-CASE : verified-by
    SPEC ||--o{ CITATION : references`;

export const USECASE_STUB = `flowchart LR
    User((User)) --> UC1[Create spec]
    User --> UC2[Read spec]
    User --> UC3[Edit spec]
    User --> UC4[Delete spec]
    UC1 -.-> SYS[(specs/ MOC)]
    UC2 -.-> SYS
    UC3 -.-> SYS
    UC4 -.-> SYS`;

export const STUB_DIAGRAMS: readonly string[] = [FLOWCHART_STUB, ER_STUB, USECASE_STUB];

function normalizeDiagramBlock(block: string): string {
	return (block ?? "").trim().replace(/\s+/g, " ");
}

/** True when a raw ```mermaid block body (as extracted by mermaidBlocks()) is still a template stub. */
export function isStubDiagram(block: string): boolean {
	const normalized = normalizeDiagramBlock(block);
	if (!normalized) return false;
	return STUB_DIAGRAMS.some((stub) => normalizeDiagramBlock(stub) === normalized);
}

function escCell(s: string): string {
	return (s ?? "").replace(/\r/g, "").replace(/\n/g, "<br>").replace(/\|/g, "\\|").trim();
}

export function buildSpecMarkdown(f: SpecFields): string {
	const status: SpecStatus = f.status ?? "draft";
	const date = todayISO();
	const related = (f.related ?? []).map((r) => slugify(r)).filter(Boolean);
	const lines: string[] = [];

	lines.push("---");
	lines.push(`title: ${f.title}`);
	lines.push(`slug: ${f.slug}`);
	lines.push(`status: ${status}`);
	lines.push(`kind: ${f.kind}`);
	lines.push(`created: ${date}`);
	lines.push(`updated: ${date}`);
	lines.push(`tags: [spec]`);
	lines.push("---");
	lines.push("");
	lines.push(`# ${f.title}`);
	lines.push("");
	lines.push("## Summary");
	lines.push("");
	lines.push(f.summary.trim() || "_TODO: summary_");
	lines.push("");

	for (const s of f.explanations.length > 0
		? f.explanations
		: [{ heading: "Background", body: "_TODO: explanation_" }]) {
		lines.push(`## ${s.heading.trim() || "Explanation"}`);
		lines.push("");
		lines.push(s.body.trim() || "_TODO_");
		lines.push("");
	}

	lines.push("## Acceptance Criteria");
	lines.push("");
	for (const a of f.acceptance.length > 0 ? f.acceptance : ["_TODO: acceptance criterion_"]) {
		lines.push(`- [ ] ${a}`);
	}
	lines.push("");

	lines.push("## Flow Diagrams");
	lines.push("");
	lines.push("### Flowchart");
	lines.push("");
	lines.push("```mermaid");
	lines.push(FLOWCHART_STUB);
	lines.push("```");
	lines.push("");
	lines.push("### ER Diagram");
	lines.push("");
	lines.push("```mermaid");
	lines.push(ER_STUB);
	lines.push("```");
	lines.push("");
	lines.push("### Usecase Diagram");
	lines.push("");
	lines.push("```mermaid");
	lines.push(USECASE_STUB);
	lines.push("```");
	lines.push("");

	lines.push("## Test Cases");
	lines.push("");
	lines.push("| ID | Case | Steps | Expected |");
	lines.push("|---|---|---|---|");
	if (f.testCases.length > 0) {
		for (const t of f.testCases) {
			lines.push(`| ${escCell(t.id)} | ${escCell(t.case)} | ${escCell(t.steps)} | ${escCell(t.expected)} |`);
		}
	} else {
		lines.push("| TC-1 | _TODO_ | _TODO_ | _TODO_ |");
	}
	lines.push("");

	if (f.kind === "http" || f.kind === "mixed") {
		lines.push("## API — HTTP");
		lines.push("");
		lines.push("| Case Name | Method | Path | Request | Response |");
		lines.push("|---|---|---|---|---|");
		if ((f.httpRows ?? []).length > 0) {
			for (const r of f.httpRows!) {
				lines.push(
					`| ${escCell(r.caseName)} | ${escCell(r.method)} | ${escCell(r.path)} | ${escCell(r.request)} | ${escCell(r.response)} |`,
				);
			}
		} else {
			lines.push("| _TODO_ | GET | `/path` | `{}` | `{}` |");
		}
		lines.push("");
	}

	if (f.kind === "non-http" || f.kind === "mixed") {
		lines.push("## API — Non-HTTP");
		lines.push("");
		lines.push("| Function | Parameters | Returns |");
		lines.push("|---|---|---|");
		if ((f.nonHttpRows ?? []).length > 0) {
			for (const r of f.nonHttpRows!) {
				lines.push(`| ${escCell(r.name)} | ${escCell(r.parameters)} | ${escCell(r.returns)} |`);
			}
		} else {
			lines.push("| _TODO_ | `()` | `void` |");
		}
		lines.push("");
	}

	lines.push("## Pros / Cons");
	lines.push("");
	lines.push("| Option | Pros | Cons |");
	lines.push("|---|---|---|");
	if (f.prosCons.length > 0) {
		for (const r of f.prosCons) {
			lines.push(`| ${escCell(r.option)} | ${escCell(r.pros)} | ${escCell(r.cons)} |`);
		}
	} else {
		lines.push("| Option A | _TODO_ | _TODO_ |");
		lines.push("| Option B | _TODO_ | _TODO_ |");
	}
	lines.push("");

	lines.push("## Citations");
	lines.push("");
	if ((f.citations ?? []).length > 0) {
		for (const c of f.citations!) lines.push(`- ${c}`);
	} else {
		lines.push("- _(optional)_");
	}
	lines.push("");

	lines.push("## Related");
	lines.push("");
	if (related.length > 0) {
		for (const r of related) lines.push(`- [[${r}]]`);
	} else {
		lines.push("- _(add [[wikilinks]] to related specs)_");
	}
	lines.push("");

	return lines.join("\n");
}

/** Minimal placeholder spec so the model has something to fill via ask-loop. */
export function buildPlaceholderSpec(slug: string, summary: string, kind: SpecKind): string {
	return buildSpecMarkdown({
		slug,
		title: slug,
		status: "draft",
		summary,
		explanations: [{ heading: "Background", body: "_TODO: gathered via ask-user loop_" }],
		acceptance: ["_TODO_"],
		kind,
		testCases: [],
		prosCons: [],
	});
}
