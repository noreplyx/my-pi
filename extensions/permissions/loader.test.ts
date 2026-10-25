import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describeCall, evaluate, normalizeDir, reloadAll, resolveGrantDir, resolveGrantPath, shortenHome } from "./loader.ts";

let tmpDirs: string[] = [];

/** Install an agent file (JSON-encoded frontmatter `permissions:` — valid
 *  YAML flow style, no quoting pitfalls) and assume its identity. */
function useAgent(rules: any[], defaultAction = "ask"): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-perm-test-"));
	tmpDirs.push(dir);
	const file = path.join(dir, "agent.md");
	const perms = JSON.stringify({ defaultAction, rules });
	fs.writeFileSync(file, `---\nname: test\npermissions: ${perms}\n---\nbody\n`);
	process.env.PI_AGENT_FILE = file;
	reloadAll();
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
	for (const k of ["PI_AGENT_NAME", "PI_AGENT_FILE"]) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
	reloadAll();
});

afterEach(() => {
	for (const k of ["PI_AGENT_NAME", "PI_AGENT_FILE"]) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
	reloadAll();
	for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
	tmpDirs = [];
});

describe("agent rules (first-match)", () => {
	test("deny segment blocks chained call", () => {
		useAgent([
			{ tool: "bash", match: "re:^\\s*git\\s+(status)\\b[^;&|$`<>\\n]*$", action: "allow" },
			{ tool: "bash", match: "*rm -rf*", action: "deny" },
		]);
		// Per-segment first-match: "git status" allows, "rm -rf ..." denies → whole call denies.
		const r = evaluate("bash", { command: "git status; rm -rf /tmp/x" }, "/tmp");
		expect(r.action).toBe("deny");
		expect(r.source).toBe("agent");
	});
	test("anchored allow permits plain args, chained falls to default", () => {
		useAgent([{ tool: "bash", match: "re:^\\s*git\\s+(status)\\b[^;&|$`<>\\n]*$", action: "allow" }]);
		expect(evaluate("bash", { command: "git status --short" }, "/tmp").action).toBe("allow");
		expect(evaluate("bash", { command: "git status; id" }, "/tmp").action).toBe("ask");
		expect(evaluate("bash", { command: "git status | head" }, "/tmp").action).toBe("ask");
	});
});

describe("shell chain evaluation (strict, per-segment)", () => {
	test("all-allow chain passes silently", () => {
		useAgent([
			{ tool: "bash", match: "re:^\\s*git\\s+(status)\\b", action: "allow" },
			{ tool: "bash", match: "re:^\\s*git\\s+(diff)\\b", action: "allow" },
		]);
		const r = evaluate("bash", { command: "git status && git diff" }, "/tmp");
		expect(r.action).toBe("allow");
		expect(r.segmentCount).toBe(2);
	});
	test("one deny segment blocks whole chain with segment index", () => {
		useAgent([
			{ tool: "bash", match: "re:^\\s*git\\s+(status)\\b", action: "allow" },
			{ tool: "bash", match: "*rm -rf*", action: "deny" },
		]);
		const r = evaluate("bash", { command: "git status; rm -rf /tmp/x" }, "/tmp");
		expect(r.action).toBe("deny");
		expect(r.segmentCount).toBe(2);
		expect(r.segmentIndex).toBe(1);
		expect(r.segment).toContain("rm -rf");
	});
	test("allowed + unknown segment falls to ask", () => {
		useAgent([{ tool: "bash", match: "re:^\\s*git\\s+(status)\\b", action: "allow" }]);
		const r = evaluate("bash", { command: "git status && id" }, "/tmp");
		expect(r.action).toBe("ask");
		expect(r.segmentCount).toBe(2);
		expect(r.segmentIndex).toBe(1);
	});
	test("pipes split into segments", () => {
		useAgent([
			{ tool: "bash", match: "re:^\\s*git\\s+(status)\\b", action: "allow" },
			{ tool: "bash", match: "re:^\\s*head\\b", action: "allow" },
		]);
		expect(evaluate("bash", { command: "git status | head" }, "/tmp").action).toBe("allow");
	});
	test("powershell chains split like bash", () => {
		useAgent([{ tool: "powershell", match: "re:^\\s*git\\s+(status)\\b", action: "allow" }]);
		expect(evaluate("powershell", { command: "git status; id" }, "/tmp").action).toBe("ask");
	});
	test("quoted delimiters do not create segments", () => {
		useAgent([{ tool: "bash", match: "re:^echo", action: "allow" }], "ask");
		// Whole command is one echo segment → allow, not split on quoted ";".
		const r = evaluate("bash", { command: `echo "a; b"` }, "/tmp");
		expect(r.action).toBe("allow");
		expect(r.segmentCount).toBeUndefined();
	});
});

describe("fail-closed invalid regex", () => {
	test("broken deny blocks", () => {
		useAgent([{ tool: "bash", match: "re:([", action: "deny" }]);
		const r = evaluate("bash", { command: "echo hello" }, "/tmp");
		expect(r.action).toBe("deny");
	});
	test("broken allow never matches (falls through)", () => {
		useAgent([{ tool: "bash", match: "re:([", action: "allow" }], "ask");
		expect(evaluate("bash", { command: "echo hello" }, "/tmp").action).toBe("ask");
	});
});

describe("path segment globs", () => {
	test("src/* does not cross segments", () => {
		useAgent([{ tool: "read", match: "src/*", action: "deny" }], "allow");
		expect(evaluate("read", { path: "src/a" }, "/repo").action).toBe("deny");
		expect(evaluate("read", { path: "src/a/b" }, "/repo").action).toBe("allow");
	});
	test("** still crosses segments", () => {
		useAgent([{ tool: "read", match: "**/.env*", action: "deny" }], "allow");
		expect(evaluate("read", { path: "sub/.env.local" }, "/repo").action).toBe("deny");
	});
});

describe("agent layer (no global fallback)", () => {
	test("subagent invocations target JSON args", () => {
		useAgent([{ tool: "subagent", action: "allow" }], "ask");
		const r = evaluate("subagent", { agent: "coder", task: "write x" }, "/repo");
		expect(r.action).toBe("allow");
		expect(r.source).toBe("agent");
	});
	test("rules apply in order, explicit default catches the rest", () => {
		useAgent([{ tool: "read", match: "**", action: "allow" }], "deny");
		expect(evaluate("read", { path: "src/a.ts" }, "/repo").action).toBe("allow");
		// write has no rule → agent default deny.
		const w = evaluate("write", { path: "x.ts" }, "/repo");
		expect(w.action).toBe("deny");
		expect(w.source).toBe("agent");
	});
	test("scoped agent deny holds under default allow", () => {
		useAgent([{ tool: "read", match: "**/.env*", action: "deny" }], "allow");
		const r = evaluate("read", { path: ".env" }, "/repo");
		expect(r.action).toBe("deny");
		expect(r.source).toBe("agent");
		expect(evaluate("read", { path: "src/a.ts" }, "/repo").action).toBe("allow");
	});
	test("name-only lookup finds project-local agent dir", () => {
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
	test("agent file without permissions block falls back to ask", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-test-"));
		tmpDirs.push(dir);
		const agentFile = path.join(dir, "plain.md");
		fs.writeFileSync(agentFile, `---\nname: plain\n---\nbody\n`);
		process.env.PI_AGENT_FILE = agentFile;
		reloadAll();
		const r = evaluate("read", { path: "x.ts" }, "/repo");
		expect(r.action).toBe("ask");
		expect(r.source).toBe("default");
	});
	test("main session without agent env falls back to ask", () => {
		// beforeEach cleared PI_AGENT_NAME/FILE: policy is agents/main.md
		// (default ask) or the hardcoded ask fallback — either way, ask.
		delete process.env.PI_AGENT_NAME;
		delete process.env.PI_AGENT_FILE;
		reloadAll();
		expect(evaluate("write", { path: "src/foo.ts" }, "/repo").action).toBe("ask");
		expect(evaluate("bash", { command: "rm -rf /tmp/x" }, "/tmp").action).toBe("ask");
	});
	test("negative agent cache is not pinned (file created after miss)", () => {
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

describe("orchestrator delegates to implementor (target allow = no prompt)", () => {
	function realAgentFile(name: string): string {
		return fileURLToPath(new URL(`../../agents/${name}.md`, import.meta.url));
	}
	test("parent subagent gate allows as orchestrator", () => {
		process.env.PI_AGENT_NAME = "orchestrator";
		process.env.PI_AGENT_FILE = realAgentFile("orchestrator");
		reloadAll();
		const r = evaluate("subagent", { agent: "code-production-implementor", task: "edit src/foo.ts" }, "/repo");
		expect(r.action).toBe("allow");
		expect(r.source).toBe("agent");
	});
	test("child edit/write allow as implementor (no prompt forwarded to parent)", () => {
		process.env.PI_AGENT_NAME = "code-production-implementor";
		process.env.PI_AGENT_FILE = realAgentFile("code-production-implementor");
		reloadAll();
		const edit = evaluate("edit", { path: "src/foo.ts" }, "/repo");
		expect(edit.action).toBe("allow");
		expect(edit.source).toBe("agent");
		const write = evaluate("write", { path: "src/foo.ts" }, "/repo");
		expect(write.action).toBe("allow");
		expect(write.source).toBe("agent");
	});
	test("implementor test-path deny still holds in-child", () => {
		process.env.PI_AGENT_NAME = "code-production-implementor";
		process.env.PI_AGENT_FILE = realAgentFile("code-production-implementor");
		reloadAll();
		expect(evaluate("edit", { path: "src/foo.test.ts" }, "/repo").action).toBe("deny");
		expect(evaluate("write", { path: "tests/foo.ts" }, "/repo").action).toBe("deny");
	});
});
