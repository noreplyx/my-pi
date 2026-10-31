import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveActiveAgentFileLabel, resolveActiveAgentLabel } from "./index.ts";
import { loadAllAgentFiles } from "./loader.ts";
import { matchToolName } from "./matcher.ts";
import { collectDiagnostics, type FileReport } from "./validate.ts";

function agentFile(label: string, rules: any[] = []): FileReport {
	return {
		label,
		exists: true,
		isAgent: true,
		validated: {
			config: { defaultAction: "ask", rules },
			errors: [],
			hasDefault: false,
		},
	};
}

function twoAgents(): FileReport[] {
	return [agentFile("agents/main.md"), agentFile("agents/reviewer.md")];
}

// Session identity is always injected via the env param — process.env is
// never mutated by these tests.
describe("picking the current agent file from session identity", () => {
	test("uses the exact file path when it matches a report", () => {
		expect(resolveActiveAgentFileLabel(twoAgents(), { PI_AGENT_FILE: "agents/reviewer.md" })).toBe(
			"agents/reviewer.md",
		);
	});

	test("finds the file from a short name", () => {
		expect(resolveActiveAgentFileLabel(twoAgents(), { PI_AGENT_FILE: "reviewer.md" })).toBe(
			"agents/reviewer.md",
		);
	});

	test("finds the file from a full location on disk", () => {
		expect(
			resolveActiveAgentFileLabel(twoAgents(), { PI_AGENT_FILE: "/proj/agents/reviewer.md" }),
		).toBe("agents/reviewer.md");
	});

	test("finds the file from a windows location on disk", () => {
		expect(
			resolveActiveAgentFileLabel(twoAgents(), {
				PI_AGENT_FILE: "C:\\proj\\agents\\reviewer.md",
			}),
		).toBe("agents/reviewer.md");
	});

	test("falls back to the main file when the file name is unknown", () => {
		expect(
			resolveActiveAgentFileLabel(twoAgents(), { PI_AGENT_FILE: "/proj/agents/ghost.md" }),
		).toBe("agents/main.md");
	});

	test("gives up when the file name is unknown and there is no main file", () => {
		expect(
			resolveActiveAgentFileLabel([agentFile("agents/reviewer.md")], {
				PI_AGENT_FILE: "/proj/agents/ghost.md",
			}),
		).toBeNull();
	});

	test("matches on file name regardless of parent folder", () => {
		// Basename matching intentionally ignores the parent directory:
		// "/xagents/reviewer.md" has basename "reviewer.md", so it resolves
		// to "agents/reviewer.md". The "/" separator guard only applies to
		// multi-segment suffix matches with differing basenames. Truly unknown
		// basenames (e.g. "ghost.md") still fall back to main / null and are
		// never expanded to all agents.
		expect(
			resolveActiveAgentFileLabel(twoAgents(), { PI_AGENT_FILE: "/xagents/reviewer.md" }),
		).toBe("agents/reviewer.md");
	});

	test("finds the file from the agent name with or without the ending", () => {
		expect(resolveActiveAgentFileLabel(twoAgents(), { PI_AGENT_NAME: "reviewer" })).toBe(
			"agents/reviewer.md",
		);
		expect(resolveActiveAgentFileLabel(twoAgents(), { PI_AGENT_NAME: "reviewer.md" })).toBe(
			"agents/reviewer.md",
		);
	});

	test("falls back to the main file when the agent name is unknown", () => {
		expect(resolveActiveAgentFileLabel(twoAgents(), { PI_AGENT_NAME: "ghost" })).toBe(
			"agents/main.md",
		);
	});

	test("gives up when the agent name is unknown and there is no main file", () => {
		expect(
			resolveActiveAgentFileLabel([agentFile("agents/reviewer.md")], { PI_AGENT_NAME: "ghost" }),
		).toBeNull();
	});

	test("falls back to the main file when no identity is given", () => {
		expect(resolveActiveAgentFileLabel(twoAgents(), {})).toBe("agents/main.md");
	});

	test("gives up when no identity is given and there is no main file", () => {
		expect(resolveActiveAgentFileLabel([agentFile("agents/reviewer.md")], {})).toBeNull();
	});

	test("prefers the file path over the agent name", () => {
		expect(
			resolveActiveAgentFileLabel(
				[agentFile("agents/main.md"), agentFile("agents/reviewer.md"), agentFile("agents/deployer.md")],
				{ PI_AGENT_FILE: "agents/reviewer.md", PI_AGENT_NAME: "deployer" },
			),
		).toBe("agents/reviewer.md");
	});

	test("treats blank identity values as unset", () => {
		expect(
			resolveActiveAgentFileLabel(twoAgents(), { PI_AGENT_FILE: "   ", PI_AGENT_NAME: "reviewer" }),
		).toBe("agents/reviewer.md");
		expect(resolveActiveAgentFileLabel(twoAgents(), { PI_AGENT_FILE: "   " })).toBe(
			"agents/main.md",
		);
	});

	test("keeps the previous resolver name working the same way", () => {
		const reports = twoAgents();
		const envs: Record<string, string | undefined>[] = [
			{ PI_AGENT_FILE: "agents/reviewer.md" },
			{ PI_AGENT_NAME: "reviewer" },
			{},
		];
		for (const env of envs) {
			expect(resolveActiveAgentLabel(reports, env)).toBe(resolveActiveAgentFileLabel(reports, env));
		}
	});
});

describe("startup pipeline from identity to validation", () => {
	test("warns only for the current file but reports broken patterns everywhere", () => {
		const files = [
			agentFile("agents/reviewer.md", [
				{ tool: "nostool_xyz", action: "ask" },
				{ tool: "bash", match: "re:([", action: "deny" },
			]),
			agentFile("agents/deployer.md", [
				{ tool: "nostool_xyz", action: "ask" },
				{ tool: "bash", match: "re:([", action: "deny" },
			]),
		];
		const active = resolveActiveAgentFileLabel(files, { PI_AGENT_FILE: "agents/reviewer.md" });
		const diags = collectDiagnostics(files, ["read", "bash"], {
			scopeUnknownToolCheckToActive: true,
			activeFileLabel: active,
		});
		const unknownTool = diags.filter((d) => d.tag?.kind === "unknown-tool");
		expect(unknownTool.length).toBe(1);
		expect(unknownTool[0].location.startsWith("agents/reviewer.md")).toBe(true);
		const broken = diags.filter((d) => d.severity === "error" && d.message.includes("invalid regex"));
		expect(broken.length).toBe(2);
	});

	test("drops the warning once the tool has been seen in use", () => {
		const files = [agentFile("agents/reviewer.md", [{ tool: "custom-tool", action: "ask" }])];
		const active = resolveActiveAgentFileLabel(files, { PI_AGENT_NAME: "reviewer" });
		const diags = collectDiagnostics(files, ["read"], {
			scopeUnknownToolCheckToActive: true,
			activeFileLabel: active,
		});
		expect(diags.filter((d) => d.tag?.kind === "unknown-tool").length).toBe(1);
		// Same retraction rule as the extension runtime: a warning retracts as
		// soon as its pattern matches an actually-invoked tool.
		const seenTools = new Set(["custom-tool"]);
		const remaining = diags.filter((d) => {
			if (d.tag?.kind !== "unknown-tool") return true;
			for (const seen of seenTools) {
				try {
					if (matchToolName(d.tag.pattern, seen)) return false;
				} catch {
					// ignore a bad pattern here — R1 already reported it
				}
			}
			return true;
		});
		expect(remaining.filter((d) => d.tag?.kind === "unknown-tool").length).toBe(0);
	});
});

describe("real agent folder resolves and validates end to end", () => {
	let tmpDirs: string[] = [];
	afterEach(() => {
		for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
		tmpDirs = [];
	});

	test("loads the folder, picks the current file, and scopes the warning", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-scope-"));
		tmpDirs.push(root);
		const agentsDir = path.join(root, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		const mainPerms = JSON.stringify({ defaultAction: "ask", rules: [{ tool: "read", action: "ask" }] });
		const reviewerPerms = JSON.stringify({
			defaultAction: "ask",
			rules: [{ tool: "nostool_xyz", action: "ask" }],
		});
		fs.writeFileSync(path.join(agentsDir, "main.md"), `---\npermissions: ${mainPerms}\n---\nbody\n`);
		fs.writeFileSync(
			path.join(agentsDir, "reviewer.md"),
			`---\npermissions: ${reviewerPerms}\n---\nbody\n`,
		);
		// Labels are rooted at .pi/agents (see loader labelForFile), so the
		// e2e reports below use ".pi/agents"-relative labels.
		const scanned = loadAllAgentFiles(root).filter((agentReport) => agentReport.filePath.startsWith(root));
		expect(scanned.length).toBe(2);
		const files: FileReport[] = scanned.map((agentReport) => ({
			label: agentReport.label,
			exists: true,
			validated: agentReport.validated,
			isAgent: true,
		}));
		const reviewerLabel = scanned.find((agentReport) => agentReport.filePath.endsWith("reviewer.md"))?.label;
		expect(reviewerLabel).toBeDefined();
		const active = resolveActiveAgentFileLabel(files, { PI_AGENT_NAME: "reviewer" });
		expect(active).toBe(reviewerLabel);
		const diags = collectDiagnostics(files, ["read", "bash"], {
			scopeUnknownToolCheckToActive: true,
			activeFileLabel: active,
		});
		const unknownTool = diags.filter((d) => d.tag?.kind === "unknown-tool");
		expect(unknownTool.length).toBe(1);
		expect(unknownTool[0].location.startsWith(reviewerLabel!)).toBe(true);
	});
});
