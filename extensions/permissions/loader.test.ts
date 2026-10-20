import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describeCall, evaluate, normalizeDir, reloadAll, resolveGrantDir, resolveGrantPath, shortenHome } from "./loader.ts";

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

describe("shell chain evaluation (strict, per-segment)", () => {
	test("all-allow chain passes silently", () => {
		const f = writeTempJson([
			{ tool: "bash", match: "re:^\\s*git\\s+(status)\\b", action: "allow" },
			{ tool: "bash", match: "re:^\\s*git\\s+(diff)\\b", action: "allow" },
		]);
		process.env.PI_PERMISSIONS_FILE = f;
		reloadAll();
		const r = evaluate("bash", { command: "git status && git diff" }, "/tmp");
		expect(r.action).toBe("allow");
		expect(r.segmentCount).toBe(2);
	});
	test("one deny segment blocks whole chain with segment index", () => {
		const f = writeTempJson([
			{ tool: "bash", match: "re:^\\s*git\\s+(status)\\b", action: "allow" },
			{ tool: "bash", match: "*rm -rf*", action: "deny" },
		]);
		process.env.PI_PERMISSIONS_FILE = f;
		reloadAll();
		const r = evaluate("bash", { command: "git status; rm -rf /tmp/x" }, "/tmp");
		expect(r.action).toBe("deny");
		expect(r.segmentCount).toBe(2);
		expect(r.segmentIndex).toBe(1);
		expect(r.segment).toContain("rm -rf");
	});
	test("allowed + unknown segment falls to ask", () => {
		const f = writeTempJson([{ tool: "bash", match: "re:^\\s*git\\s+(status)\\b", action: "allow" }]);
		process.env.PI_PERMISSIONS_FILE = f;
		reloadAll();
		const r = evaluate("bash", { command: "git status && id" }, "/tmp");
		expect(r.action).toBe("ask");
		expect(r.segmentCount).toBe(2);
		expect(r.segmentIndex).toBe(1);
	});
	test("pipes split into segments", () => {
		const f = writeTempJson([
			{ tool: "bash", match: "re:^\\s*git\\s+(status)\\b", action: "allow" },
			{ tool: "bash", match: "re:^\\s*head\\b", action: "allow" },
		]);
		process.env.PI_PERMISSIONS_FILE = f;
		reloadAll();
		expect(evaluate("bash", { command: "git status | head" }, "/tmp").action).toBe("allow");
	});
	test("powershell chains split like bash", () => {
		const f = writeTempJson([{ tool: "powershell", match: "re:^\\s*git\\s+(status)\\b", action: "allow" }]);
		process.env.PI_PERMISSIONS_FILE = f;
		reloadAll();
		expect(evaluate("powershell", { command: "git status; id" }, "/tmp").action).toBe("ask");
	});
	test("quoted delimiters do not create segments", () => {
		const f = writeTempJson([{ tool: "bash", match: "re:^echo", action: "allow" }], "ask");
		process.env.PI_PERMISSIONS_FILE = f;
		reloadAll();
		// Whole command is one echo segment → allow, not split on quoted ";".
		const r = evaluate("bash", { command: `echo "a; b"` }, "/tmp");
		expect(r.action).toBe("allow");
		expect(r.segmentCount).toBeUndefined();
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

describe("grant dir resolution", () => {
	test("file tools resolve to the containing directory", () => {
		expect(resolveGrantPath("write", { path: "src/a.txt" }, "/proj")).toBe("/proj/src/a.txt");
		expect(resolveGrantDir("write", { path: "src/a.txt" }, "/proj")).toBe("/proj/src");
		expect(resolveGrantPath("grep", { path: "src", pattern: "foo" }, "/proj")).toBe("/proj/src");
	});

	test("existing directory target grants itself", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-grantdir-"));
		tmpDirs.push(root);
		const sub = path.join(root, "sub");
		fs.mkdirSync(sub);
		expect(resolveGrantDir("ls", { path: sub }, "/")).toBe(sub);
		expect(resolveGrantPath("ls", { path: sub }, "/")).toBe(sub);
	});

	test("nonexistent path grants its parent, bash returns null", () => {
		expect(resolveGrantDir("write", { path: "/nope/nested/f.txt" }, "/")).toBe("/nope/nested");
		expect(resolveGrantPath("bash", { command: "ls" }, "/proj")).toBeNull();
		expect(resolveGrantDir("bash", { command: "ls" }, "/proj")).toBeNull();
		expect(resolveGrantDir("write", {}, "/proj")).toBeNull();
	});

	test("relative and trailing-slash paths normalize", () => {
		expect(resolveGrantPath("write", { path: "../x.txt" }, "/proj/sub")).toBe("/proj/x.txt");
		expect(resolveGrantPath("read", { path: "/a/b/" }, "/")).toBe("/a/b");
		expect(normalizeDir("/")).toBe("/");
	});
});

describe("describeCall", () => {
	test("file tools show action + cwd-relative path", () => {
		expect(describeCall("write", { path: "src/foo.txt" }, "/proj")).toBe("write src/foo.txt");
		expect(describeCall("read", { path: "/proj/src/bar.txt" }, "/proj")).toBe("read src/bar.txt");
		expect(describeCall("edit", { path: "x.ts" }, "/proj")).toBe("edit x.ts");
		expect(describeCall("ls", {}, "/proj")).toBe("ls .");
	});

	test("outside-cwd paths stay absolute", () => {
		expect(describeCall("read", { path: "/etc/hosts" }, "/proj")).toBe("read /etc/hosts");
		expect(describeCall("write", { path: "../up.txt" }, "/proj/sub")).toBe("write /proj/up.txt");
		expect(describeCall("write", {}, "/proj")).toBe("write (no path)");
		expect(describeCall("read", { path: "..notes.txt" }, "/proj")).toBe("read ..notes.txt");
	});

	test("grep/find append the pattern, bash shows the full command", () => {
		expect(describeCall("grep", { path: "src", pattern: "TODO" }, "/proj")).toBe('grep src "TODO"');
		expect(describeCall("find", { path: "src" }, "/proj")).toBe("find src");
		expect(describeCall("bash", { command: "npm test && npm run build" }, "/proj")).toBe("bash npm test && npm run build");
		expect(describeCall("bash", {}, "/proj")).toBe("bash (no command)");
	});

	test("other tools show key=value pairs, capped at one line", () => {
		expect(describeCall("mcp__x", { a: 1 }, "/proj")).toBe("mcp__x a=1");
		const long = describeCall("mcp__x", { data: "y".repeat(200) }, "/proj");
		expect(long.length).toBeLessThanOrEqual("mcp__x ".length + 100);
		expect(long.endsWith("…")).toBe(true);
	});
});

describe("describeCall structured tools", () => {
	test("subagent single shows agent + task snippet with home shortened", () => {
		const home = os.homedir();
		const task = `List files in ${home}/.pi/agent and summarize the repo structure for review purposes`;
		const got = describeCall("subagent", { agent: "general", task }, "/proj");
		expect(got.startsWith('subagent general "List files in ~/.pi/agent')).toBe(true);
		expect(got.endsWith('…"')).toBe(true);
		expect(got.length).toBeLessThanOrEqual(`subagent general ""`.length + 60);
	});

	test("subagent chain/parallel show shape + first step", () => {
		expect(describeCall("subagent", { chain: [{ agent: "a", task: "do one thing" }, { agent: "b", task: "do other" }] }, "/p")).toBe(
			'subagent chain (2 steps): a "do one thing"',
		);
		expect(describeCall("subagent", { tasks: [{ agent: "c", task: "only task here" }] }, "/p")).toBe(
			'subagent parallel (1 task): c "only task here"',
		);
		expect(describeCall("subagent", {}, "/p")).toBe("subagent (no details)");
		expect(describeCall("subagent", { task: "just\n  a\ntask" }, "/p")).toBe('subagent "just a task"');
	});

	test("shortenHome shortens leading home only", () => {
		const home = os.homedir();
		expect(shortenHome(`${home}/x/y`)).toBe("~/x/y");
		expect(shortenHome(home)).toBe("~");
		expect(shortenHome("/etc/hosts")).toBe("/etc/hosts");
		expect(shortenHome("rel/path")).toBe("rel/path");
	});

	test("patterns and commands collapse whitespace", () => {
		expect(describeCall("grep", { path: "src", pattern: "a\nb" }, "/proj")).toBe('grep src "a b"');
		expect(describeCall("bash", { command: "npm test\n  && npm run build" }, "/proj")).toBe("bash npm test && npm run build");
	});
});
