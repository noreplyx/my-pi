import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evaluate, reloadAll } from "./loader.ts";

let tmpFiles: string[] = [];
let tmpDirs: string[] = [];

function writeTempJson(rules: any[], defaultAction = "ask"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-perm-test-"));
	tmpDirs.push(dir);
	const file = path.join(dir, "permissions.json");
	fs.writeFileSync(file, JSON.stringify({ defaultAction, rules }));
	tmpFiles.push(file);
	return file;
}

function writeAgentFile(dir: string, name: string, frontmatter: string): string {
	const agentsDir = path.join(dir, ".pi", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	const file = path.join(agentsDir, `${name}.md`);
	fs.writeFileSync(file, `---\n${frontmatter}\n---\nbody\n`);
	return file;
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const k of ["PI_PERMISSIONS_FILE", "PI_AGENT_NAME", "PI_AGENT_FILE"]) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
	reloadAll();
});

afterEach(() => {
	for (const k of ["PI_PERMISSIONS_FILE", "PI_AGENT_NAME", "PI_AGENT_FILE"]) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
	reloadAll();
	for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
	tmpDirs = [];
	tmpFiles = [];
});

describe("global deny floor", () => {
	test("deny beats prefix allow for smuggled commands", () => {
		const f = writeTempJson([
			{ tool: "bash", match: "re:^\\s*git\\s+(status)\\b[^;&|$`<>\\n]*$", action: "allow" },
			{ tool: "bash", match: "*rm -rf*", action: "deny" },
		]);
		process.env.PI_PERMISSIONS_FILE = f;
		reloadAll();
		// Order in file is allow-then-deny; floor scans denies first regardless.
		const r = evaluate("bash", { command: "git status; rm -rf /tmp/x" }, "/tmp");
		expect(r.action).toBe("deny");
		expect(r.source).toBe("global");
	});
	test("anchored allow permits plain args, chained falls to default", () => {
		const f = writeTempJson([
			{ tool: "bash", match: "re:^\\s*git\\s+(status)\\b[^;&|$`<>\\n]*$", action: "allow" },
		]);
		process.env.PI_PERMISSIONS_FILE = f;
		reloadAll();
		expect(evaluate("bash", { command: "git status --short" }, "/tmp").action).toBe("allow");
		expect(evaluate("bash", { command: "git status; id" }, "/tmp").action).toBe("ask");
		expect(evaluate("bash", { command: "git status | head" }, "/tmp").action).toBe("ask");
	});
});

describe("fail-closed invalid regex", () => {
	test("broken deny blocks", () => {
		const f = writeTempJson([{ tool: "bash", match: "re:([", action: "deny" }]);
		process.env.PI_PERMISSIONS_FILE = f;
		reloadAll();
		const r = evaluate("bash", { command: "echo hello" }, "/tmp");
		expect(r.action).toBe("deny");
	});
	test("broken allow never matches (falls through)", () => {
		const f = writeTempJson([{ tool: "bash", match: "re:([", action: "allow" }], "ask");
		process.env.PI_PERMISSIONS_FILE = f;
		reloadAll();
		expect(evaluate("bash", { command: "echo hello" }, "/tmp").action).toBe("ask");
	});
});

describe("path segment globs", () => {
	test("src/* does not cross segments", () => {
		const f = writeTempJson([{ tool: "read", match: "src/*", action: "deny" }], "allow");
		process.env.PI_PERMISSIONS_FILE = f;
		reloadAll();
		expect(evaluate("read", { path: "src/a" }, "/repo").action).toBe("deny");
		expect(evaluate("read", { path: "src/a/b" }, "/repo").action).toBe("allow");
	});
	test("** still crosses segments", () => {
		const f = writeTempJson([{ tool: "read", match: "**/.env*", action: "deny" }], "allow");
		process.env.PI_PERMISSIONS_FILE = f;
		reloadAll();
		expect(evaluate("read", { path: "sub/.env.local" }, "/repo").action).toBe("deny");
	});
});

describe("per-agent layer", () => {
	test("agent allow loosens global ask, global deny still wins", () => {
		const gf = writeTempJson(
			[
				{ tool: "read", match: "**/.env*", action: "deny" },
				{ tool: "read", match: "**", action: "ask" },
			],
			"ask",
		);
		process.env.PI_PERMISSIONS_FILE = gf;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-test-"));
		tmpDirs.push(dir);
		const agentFile = path.join(dir, "reviewer.md");
		fs.writeFileSync(
			agentFile,
			`---\nname: reviewer\npermissions:\n  defaultAction: deny\n  rules:\n    - { tool: read, match: "**", action: allow }\n---\nbody\n`,
		);
		process.env.PI_AGENT_NAME = "reviewer";
		process.env.PI_AGENT_FILE = agentFile;
		reloadAll();
		expect(evaluate("read", { path: "src/a.ts" }, "/repo").action).toBe("allow");
		expect(evaluate("read", { path: ".env" }, "/repo").action).toBe("deny");
		// write has no agent rule + agent default deny
		expect(evaluate("write", { path: "x.ts" }, "/repo").action).toBe("deny");
	});
	test("name-only lookup finds project-local agent dir", () => {
		const gf = writeTempJson([], "ask");
		process.env.PI_PERMISSIONS_FILE = gf;
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-proj-test-"));
		tmpDirs.push(root);
		writeAgentFile(root, "local", "name: local\npermissions:\n  defaultAction: deny\n  rules: []");
		const cwd = path.join(root, "sub", "dir");
		fs.mkdirSync(cwd, { recursive: true });
		process.env.PI_AGENT_NAME = "local";
		delete process.env.PI_AGENT_FILE;
		reloadAll();
		// Agent file sets explicit default deny (with an empty-rules warning path).
		expect(evaluate("read", { path: "x" }, cwd).action).toBe("deny");
	});
	test("negative agent cache is not pinned (file created after miss)", () => {
		const gf = writeTempJson([], "ask");
		process.env.PI_PERMISSIONS_FILE = gf;
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-neg-test-"));
		tmpDirs.push(root);
		const cwd = path.join(root, "work");
		fs.mkdirSync(cwd, { recursive: true });
		process.env.PI_AGENT_NAME = "late";
		delete process.env.PI_AGENT_FILE;
		reloadAll();
		expect(evaluate("read", { path: "x" }, cwd).action).toBe("ask");
		// Agent appears after the miss — next call must see it without reloadAll.
		writeAgentFile(root, "late", "name: late\npermissions:\n  defaultAction: deny\n  rules: []");
		expect(evaluate("read", { path: "x" }, cwd).action).toBe("deny");
	});
});
