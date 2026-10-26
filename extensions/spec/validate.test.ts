import { describe, expect, test } from "bun:test";
import { buildSpecMarkdown } from "./template.ts";
import { validateSpecMarkdown } from "./validate.ts";

function fullHttp() {
	return buildSpecMarkdown({
		slug: "demo",
		title: "Demo",
		summary: "Does things.",
		explanations: [{ heading: "Background", body: "Context here." }],
		acceptance: ["Works"],
		kind: "http",
		httpRows: [{ caseName: "Get", method: "GET", path: "/x", request: "{}", response: "{}" }],
		testCases: [{ id: "TC-1", case: "Happy", steps: "1. call", expected: "200" }],
		prosCons: [{ option: "A", pros: "fast", cons: "costly" }],
		citations: ["https://example.com"],
		related: ["other"],
	});
}

describe("validateSpecMarkdown", () => {
	test("full http spec passes strict validation", () => {
		const r = validateSpecMarkdown(fullHttp(), "http");
		expect(r.ok).toBe(true);
		expect(r.missing).toEqual([]);
	});

	test("missing flowchart diagram fails", () => {
		const md = fullHttp().replace(/flowchart TD[\s\S]*?```/, "```");
		const r = validateSpecMarkdown(md, "http");
		expect(r.ok).toBe(false);
		expect(r.missing.join(" ")).toMatch(/flowchart/i);
	});

	test("missing ER diagram fails", () => {
		const md = fullHttp().replace(/erDiagram[\s\S]*?```/, "```");
		const r = validateSpecMarkdown(md, "http");
		expect(r.ok).toBe(false);
		expect(r.missing.join(" ")).toMatch(/ER/i);
	});

	test("missing usecase diagram fails", () => {
		const md = fullHttp().replace(/\(\(User\)\)[\s\S]*?```/, "```");
		const r = validateSpecMarkdown(md, "http");
		expect(r.ok).toBe(false);
		expect(r.missing.join(" ")).toMatch(/usecase/i);
	});

	test("non-http kind requires parameter/return table", () => {
		const md = buildSpecMarkdown({
			slug: "lib",
			title: "Lib",
			summary: "Library.",
			explanations: [{ heading: "Design", body: "Body." }],
			acceptance: ["Works"],
			kind: "non-http",
			nonHttpRows: [{ name: "run()", parameters: "opts", returns: "Result" }],
			testCases: [{ id: "TC-1", case: "C", steps: "S", expected: "E" }],
			prosCons: [{ option: "A", pros: "p", cons: "c" }],
		});
		const r = validateSpecMarkdown(md, "non-http");
		expect(r.ok).toBe(true);
	});

	test("http kind without HTTP table fails", () => {
		const r = validateSpecMarkdown(fullHttp(), "non-http");
		expect(r.ok).toBe(false);
		expect(r.missing.join(" ")).toMatch(/non-http api/i);
	});

	test("empty summary / missing explanation fails", () => {
		const r = validateSpecMarkdown("# T\n\n## Summary\n", "http");
		expect(r.ok).toBe(false);
		expect(r.missing.length).toBeGreaterThan(2);
	});

	test("no wikilinks warns (not errors)", () => {
		const r = validateSpecMarkdown(fullHttp().replaceAll("[[other]]", "other"), "http");
		expect(r.ok).toBe(true);
		expect(r.warnings.join(" ")).toMatch(/wikilink/i);
	});
});
