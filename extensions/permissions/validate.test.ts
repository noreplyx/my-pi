import { describe, expect, test } from "bun:test";
import { collectDiagnostics, type FileReport } from "./validate.ts";

function report(
	label: string,
	rules: any[],
	opts: { isAgent?: boolean; hasDefault?: boolean; defaultAction?: any } = {},
): FileReport {
	return {
		label,
		exists: true,
		isAgent: opts.isAgent ?? false,
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
			[report("permissions.json", [{ tool: "bash", match: "re:([", action: "deny" }])],
			[],
		);
		expect(diags.some((d) => d.severity === "error" && d.message.includes("fails closed"))).toBe(true);
	});
});

describe("agent loosens global deny (AGENT_BEATS_GLOBAL visibility)", () => {
	test("agent allow overlapping global deny reports info, not error", () => {
		const diags = collectDiagnostics(
			[
				report("permissions.json", [{ tool: "bash", match: "*rm -rf*", action: "deny" }]),
				report("agents/loose.md", [{ tool: "bash", match: "*rm -rf*", action: "allow" }], { isAgent: true }),
			],
			["bash"],
		);
		const loosen = diags.filter((d) => d.message.includes("loosens global deny"));
		expect(loosen.length).toBe(1);
		expect(loosen[0].severity).toBe("info");
		expect(loosen[0].location).toContain("agents/loose.md");
	});
	test("non-overlapping agent rule stays clean", () => {
		const diags = collectDiagnostics(
			[
				report("permissions.json", [{ tool: "bash", match: "*rm -rf*", action: "deny" }]),
				report("agents/reader.md", [{ tool: "read", match: "**", action: "allow" }], { isAgent: true }),
			],
			["bash", "read"],
		);
		expect(diags.some((d) => d.message.includes("loosens global deny"))).toBe(false);
	});
	test("agent default allow loosens every global deny", () => {
		const diags = collectDiagnostics(
			[
				report("permissions.json", [{ tool: "read", match: "**/.env*", action: "deny" }]),
				report("agents/open.md", [], { isAgent: true, hasDefault: true, defaultAction: "allow" }),
			],
			["read"],
		);
		expect(diags.some((d) => d.message.includes('default "allow" loosens'))).toBe(true);
	});
});

describe("R6 prefix-anchored shell allow", () => {
	test("warns on unanchored prefix allow", () => {
		const diags = collectDiagnostics(
			[report("permissions.json", [{ tool: "bash", match: "re:^git\\s+(status)\\b", action: "allow" }])],
			["bash"],
		);
		expect(diags.some((d) => d.message.includes("chained commands"))).toBe(true);
	});
	test("anchored allow is clean", () => {
		const diags = collectDiagnostics(
			[
				report("permissions.json", [
					{ tool: "bash", match: "re:^\\s*git\\s+(status)\\b[^;&|$`<>\\n]*$", action: "allow" },
				]),
			],
			["bash"],
		);
		expect(diags.some((d) => d.message.includes("chained commands"))).toBe(false);
	});
	test("non-shell allows are unaffected", () => {
		const diags = collectDiagnostics(
			[report("permissions.json", [{ tool: "read", match: "re:^src/", action: "allow" }])],
			["bash", "read"],
		);
		expect(diags.some((d) => d.message.includes("chained commands"))).toBe(false);
	});
});
