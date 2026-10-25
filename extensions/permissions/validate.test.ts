import { describe, expect, test } from "bun:test";
import { collectDiagnostics, type FileReport } from "./validate.ts";

function report(
	label: string,
	rules: any[],
	opts: { hasDefault?: boolean; defaultAction?: any } = {},
): FileReport {
	return {
		label,
		exists: true,
		isAgent: true,
		validated: {
			config: {
				defaultAction: opts.defaultAction ?? "ask",
				rules,
			},
			errors: [],
			hasDefault: opts.hasDefault ?? false,
		},
	};
}

describe("R1 invalid regex", () => {
	test("reports error with fail-closed wording", () => {
		const diags = collectDiagnostics(
			[report("agents/reviewer.md", [{ tool: "bash", match: "re:([", action: "deny" }])],
			[],
		);
		expect(diags.some((d) => d.severity === "error" && d.message.includes("fails closed"))).toBe(true);
	});
});

describe("missing agent file", () => {
	test("missing main.md warns and falls back to ask", () => {
		const diags = collectDiagnostics(
			[
				{
					label: "agents/main.md",
					exists: false,
					isAgent: true,
					validated: { config: { defaultAction: "ask", rules: [] }, errors: [], hasDefault: false },
				},
			],
			[],
		);
		expect(diags.some((d) => d.severity === "warning" && d.message.includes("no agent policy file"))).toBe(true);
	});
});

describe("R6 prefix-anchored shell allow", () => {
	test("warns on unanchored prefix allow", () => {
		const diags = collectDiagnostics(
			[report("agents/reviewer.md", [{ tool: "bash", match: "re:^git\\s+(status)\\b", action: "allow" }])],
			["bash"],
		);
		expect(diags.some((d) => d.message.includes("chained commands"))).toBe(true);
	});
	test("anchored allow is clean", () => {
		const diags = collectDiagnostics(
			[
				report("agents/reviewer.md", [
					{ tool: "bash", match: "re:^\\s*git\\s+(status)\\b[^;&|$`<>\\n]*$", action: "allow" },
				]),
			],
			["bash"],
		);
		expect(diags.some((d) => d.message.includes("chained commands"))).toBe(false);
	});
	test("non-shell allows are unaffected", () => {
		const diags = collectDiagnostics(
			[report("agents/reader.md", [{ tool: "read", match: "re:^src/", action: "allow" }])],
			["bash", "read"],
		);
		expect(diags.some((d) => d.message.includes("chained commands"))).toBe(false);
	});
});
