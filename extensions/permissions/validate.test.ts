import { describe, expect, test } from "bun:test";
import { baseNameOf, collectDiagnostics, isActiveAgentFile, type FileReport } from "./validate.ts";

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

describe("R1b invalid glob", () => {
	test("reports error with fail-closed wording", () => {
		const diags = collectDiagnostics(
			[report("agents/reviewer.md", [{ tool: "read", match: "[z-a]", action: "deny" }])],
			["read"],
		);
		expect(
			diags.some((d) => d.severity === "error" && d.message.includes("invalid glob") && d.message.includes("fails closed")),
		).toBe(true);
	});
	test("valid glob is clean", () => {
		const diags = collectDiagnostics(
			[report("agents/reviewer.md", [{ tool: "read", match: "src/*.ts", action: "allow" }])],
			["read"],
		);
		expect(diags.some((d) => d.message.includes("invalid glob"))).toBe(false);
	});
});

describe("R2 tool matching is case-insensitive", () => {
	test("no unknown-tool warning on case-only mismatch", () => {
		const diags = collectDiagnostics(
			[report("agents/reviewer.md", [{ tool: "Read", match: "src/*", action: "allow" }])],
			["read"],
		);
		expect(diags.some((d) => d.message.includes("matches no known tool"))).toBe(false);
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

describe("unknown-tool warning follows the current agent file", () => {
	const twoTypoFiles = () => [
		report("agents/reviewer.md", [{ tool: "nostool_xyz", action: "ask" }]),
		report("agents/deployer.md", [{ tool: "nostool_xyz", action: "ask" }]),
	];
	const unknownToolFor = (diags: { location: string; tag?: { kind: string } }[], label: string) =>
		diags.filter((d) => d.tag?.kind === "unknown-tool" && d.location.startsWith(label));

	test("warns for the current agent file and stays silent for the other file", () => {
		const diags = collectDiagnostics(twoTypoFiles(), ["read", "bash"], {
			scopeUnknownToolCheckToActive: true,
			activeFileLabel: "agents/reviewer.md",
		});
		expect(unknownToolFor(diags, "agents/reviewer.md").length).toBe(1);
		expect(unknownToolFor(diags, "agents/deployer.md").length).toBe(0);
	});

	test("still reports a broken pattern in every file, not just the current one", () => {
		const files = [
			report("agents/reviewer.md", [{ tool: "bash", match: "re:([", action: "deny" }]),
			report("agents/deployer.md", [{ tool: "bash", match: "re:([", action: "deny" }]),
		];
		const diags = collectDiagnostics(files, ["bash"], {
			scopeUnknownToolCheckToActive: true,
			activeFileLabel: "agents/reviewer.md",
		});
		const broken = diags.filter((d) => d.severity === "error" && d.message.includes("invalid regex"));
		expect(broken.length).toBe(2);
		expect(broken.some((d) => d.location.startsWith("agents/reviewer.md"))).toBe(true);
		expect(broken.some((d) => d.location.startsWith("agents/deployer.md"))).toBe(true);
	});

	test("stays silent everywhere when the current file is unknown", () => {
		const diags = collectDiagnostics(twoTypoFiles(), ["read", "bash"], {
			scopeUnknownToolCheckToActive: true,
			activeFileLabel: null,
		});
		expect(diags.filter((d) => d.tag?.kind === "unknown-tool").length).toBe(0);
	});

	test("treats a blank current file name the same as unknown", () => {
		const diags = collectDiagnostics(twoTypoFiles(), ["read", "bash"], {
			scopeUnknownToolCheckToActive: true,
			activeFileLabel: "   ",
		});
		expect(diags.filter((d) => d.tag?.kind === "unknown-tool").length).toBe(0);
	});

	test("warns in every file when scoping is turned off", () => {
		const diags = collectDiagnostics(twoTypoFiles(), ["read", "bash"]);
		expect(unknownToolFor(diags, "agents/reviewer.md").length).toBe(1);
		expect(unknownToolFor(diags, "agents/deployer.md").length).toBe(1);
	});
});

describe("unknown-tool warning details", () => {
	test("skips the check when the tool list is empty", () => {
		const diags = collectDiagnostics(
			[report("agents/reviewer.md", [{ tool: "nostool_xyz", action: "ask" }])],
			[],
			{ scopeUnknownToolCheckToActive: true, activeFileLabel: "agents/reviewer.md" },
		);
		expect(diags.filter((d) => d.tag?.kind === "unknown-tool").length).toBe(0);
	});

	test("lets pattern tools through without a warning", () => {
		for (const tool of ["re:^read.*", "*"]) {
			const diags = collectDiagnostics(
				[report("agents/reviewer.md", [{ tool, action: "ask" }])],
				["read", "bash"],
				{ scopeUnknownToolCheckToActive: true, activeFileLabel: "agents/reviewer.md" },
			);
			expect(diags.filter((d) => d.tag?.kind === "unknown-tool").length).toBe(0);
		}
	});

	test("carries a machine-readable tag for later retraction", () => {
		const diags = collectDiagnostics(
			[report("agents/reviewer.md", [{ tool: "nostool_xyz", action: "ask" }])],
			["read"],
			{ scopeUnknownToolCheckToActive: true, activeFileLabel: "agents/reviewer.md" },
		);
		const tagged = diags.filter((d) => d.tag?.kind === "unknown-tool");
		expect(tagged.length).toBe(1);
		expect(tagged[0].tag).toEqual({ kind: "unknown-tool", pattern: "nostool_xyz" });
	});

	test("supports the previous option names and prefers the current ones", () => {
		const files = () => [
			report("agents/reviewer.md", [{ tool: "nostool_xyz", action: "ask" }]),
			report("agents/deployer.md", [{ tool: "nostool_xyz", action: "ask" }]),
		];
		// Previous names behave the same as current names.
		const legacy = collectDiagnostics(files(), ["read"], {
			scopeR2ToActive: true,
			activeLabel: "agents/reviewer.md",
		});
		expect(legacy.filter((d) => d.tag?.kind === "unknown-tool" && d.location.startsWith("agents/reviewer.md")).length).toBe(1);
		expect(legacy.filter((d) => d.tag?.kind === "unknown-tool" && d.location.startsWith("agents/deployer.md")).length).toBe(0);
		// When both are given, the current names win (point at deployer).
		const both = collectDiagnostics(files(), ["read"], {
			scopeUnknownToolCheckToActive: true,
			activeFileLabel: "agents/deployer.md",
			scopeR2ToActive: false,
			activeLabel: "agents/reviewer.md",
		});
		expect(both.filter((d) => d.tag?.kind === "unknown-tool" && d.location.startsWith("agents/deployer.md")).length).toBe(1);
		expect(both.filter((d) => d.tag?.kind === "unknown-tool" && d.location.startsWith("agents/reviewer.md")).length).toBe(0);
	});
});

describe("recognising the current agent file", () => {
	test("matches when the path is exactly the same", () => {
		expect(isActiveAgentFile("agents/reviewer.md", "agents/reviewer.md")).toBe(true);
	});

	test("matches when only the file name is given", () => {
		expect(isActiveAgentFile("agents/reviewer.md", "reviewer.md")).toBe(true);
		expect(isActiveAgentFile("reviewer.md", "agents/reviewer.md")).toBe(true);
	});

	test("matches when the current path is a longer location ending with the file path", () => {
		expect(isActiveAgentFile("/proj/agents/reviewer.md", "agents/reviewer.md")).toBe(true);
		expect(isActiveAgentFile("agents/reviewer.md", "/proj/agents/reviewer.md")).toBe(true);
	});

	test("rejects a lookalike name without a separator", () => {
		// Bare substring ("eviewer.md") must not count — a "/" separator is required.
		expect(isActiveAgentFile("agents/reviewer.md", "eviewer.md")).toBe(false);
		expect(isActiveAgentFile("agents/reviewer.md", "agents/reviewer.m")).toBe(false);
	});

	test("stays unmatched when either side is missing or blank", () => {
		expect(isActiveAgentFile("agents/reviewer.md", null)).toBe(false);
		expect(isActiveAgentFile("agents/reviewer.md", "   ")).toBe(false);
		expect(isActiveAgentFile("   ", "agents/reviewer.md")).toBe(false);
	});

	test("matches across windows and unix separators", () => {
		expect(isActiveAgentFile("agents\\reviewer.md", "agents/reviewer.md")).toBe(true);
		expect(isActiveAgentFile("C:\\proj\\agents\\reviewer.md", "agents/reviewer.md")).toBe(true);
	});

	test("treats upper and lower case names as different", () => {
		expect(isActiveAgentFile("agents/Reviewer.md", "agents/reviewer.md")).toBe(false);
	});

	test("reads the file name out of a windows drive path", () => {
		expect(baseNameOf("C:\\proj\\agents\\reviewer.md")).toBe("reviewer.md");
		expect(baseNameOf("agents/reviewer.md")).toBe("reviewer.md");
	});
});
