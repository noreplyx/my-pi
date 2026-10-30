/** Dialog-branch tests for the permissions extension (mocked ExtensionAPI + ctx.ui). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import factory from "./index.ts";
import { reloadAll } from "./loader.ts";

let tmpDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

/** Install an ask-by-default agent so every tool call reaches the dialog branch. */
function useAskAgent(): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-perm-dialog-"));
	tmpDirs.push(dir);
	const file = path.join(dir, "agent.md");
	fs.writeFileSync(file, `---\nname: test\npermissions: ${JSON.stringify({ defaultAction: "ask", rules: [] })}\n---\nbody\n`);
	process.env.PI_AGENT_FILE = file;
	reloadAll();
}

beforeEach(() => {
	for (const k of ["PI_AGENT_NAME", "PI_AGENT_FILE", "PI_AUTO_APPROVE"]) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
	reloadAll();
	useAskAgent();
});

afterEach(() => {
	for (const k of ["PI_AGENT_NAME", "PI_AGENT_FILE", "PI_AUTO_APPROVE"]) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
	reloadAll();
	for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
	tmpDirs = [];
});

function makePi() {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const pi: any = {
		on: (event: string, handler: any) => {
			handlers.set(event, handler);
			return () => {};
		},
		registerCommand: () => {},
		getAllTools: () => [{ name: "bash" }, { name: "write" }, { name: "read" }],
	};
	(factory as any)(pi);
	return handlers.get("tool_call");
}

function makeCtx(over: Record<string, any> = {}, uiOver: Record<string, any> = {}) {
	const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-perm-cwd-"));
	tmpDirs.push(workdir);
	const ui: any = {
		notify: () => {},
		select: async () => undefined,
		confirm: async () => true,
		input: async () => undefined,
		...uiOver,
	};
	return { ctx: { cwd: workdir, hasUI: true, signal: undefined, ui, ...over } as any, workdir };
}

describe("permission dialog", () => {
	test("lets the user allow the tool just once without remembering it", async () => {
		const handler = makePi();
		let selectCalls = 0;
		let seenOptions: unknown;
		const { ctx } = makeCtx({}, {
			select: async (_title: string, options: string[]) => {
				selectCalls++;
				seenOptions = options;
				return "Allow once";
			},
		});
		const event = { toolName: "bash", input: { command: "npm test" } };
		const first = await handler(event, ctx);
		expect(first).toBeUndefined();
		expect(seenOptions).toEqual(["Allow once", "Allow for this session", "Deny", "Deny with feedback"]);
		// No grant is stored: asking again prompts again.
		const second = await handler(event, ctx);
		expect(second).toBeUndefined();
		expect(selectCalls).toBe(2);
	});

	test("remembers an exact tool approval for the rest of the session", async () => {
		const handler = makePi();
		let selectCalls = 0;
		const { ctx } = makeCtx({}, {
			select: async () => {
				selectCalls++;
				return "Allow for this session";
			},
		});
		const event = { toolName: "bash", input: { command: "npm test" } };
		expect(await handler(event, ctx)).toBeUndefined();
		expect(await handler(event, ctx)).toBeUndefined();
		expect(selectCalls).toBe(1);
	});

	test("remembers a folder approval for other files in the same folder", async () => {
		const handler = makePi();
		let selectCalls = 0;
		const { ctx, workdir } = makeCtx({}, {
			select: async () => {
				selectCalls++;
				return "Allow for this session";
			},
		});
		const srcDir = path.join(workdir, "src");
		fs.mkdirSync(srcDir, { recursive: true });
		expect(await handler({ toolName: "write", input: { path: path.join(srcDir, "a.txt") } }, ctx)).toBeUndefined();
		// A sibling file in the same folder is covered without re-prompting.
		expect(await handler({ toolName: "write", input: { path: path.join(srcDir, "b.txt") } }, ctx)).toBeUndefined();
		expect(selectCalls).toBe(1);
	});

	test("blocks the tool when the user picks Deny", async () => {
		const handler = makePi();
		const { ctx } = makeCtx({}, { select: async () => "Deny" });
		const result = await handler({ toolName: "bash", input: { command: "rm -rf /tmp/x" } }, ctx);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("Denied by user");
		expect(result?.reason).not.toContain("Feedback:");
	});

	test("blocks the tool when the user dismisses the prompt", async () => {
		const handler = makePi();
		const { ctx } = makeCtx({}, { select: async () => undefined });
		const result = await handler({ toolName: "bash", input: { command: "npm test" } }, ctx);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("Denied by user");
	});

	test("includes the user's guidance when they deny with feedback", async () => {
		const handler = makePi();
		const { ctx } = makeCtx({}, {
			select: async () => "Deny with feedback",
			input: async () => "use read instead",
		});
		const result = await handler({ toolName: "bash", input: { command: "npm test" } }, ctx);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("Denied by user");
		expect(result?.reason).toContain("Feedback: use read instead");
	});

	test("denies plainly when the feedback box is left empty", async () => {
		const handler = makePi();
		const { ctx } = makeCtx({}, {
			select: async () => "Deny with feedback",
			input: async () => "",
		});
		const result = await handler({ toolName: "bash", input: { command: "npm test" } }, ctx);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("Denied by user");
		expect(result?.reason).not.toContain("Feedback:");
	});

	test("denies plainly when the feedback is only spaces", async () => {
		const handler = makePi();
		const { ctx } = makeCtx({}, {
			select: async () => "Deny with feedback",
			input: async () => "   \n  ",
		});
		const result = await handler({ toolName: "bash", input: { command: "npm test" } }, ctx);
		expect(result?.block).toBe(true);
		expect(result?.reason).not.toContain("Feedback:");
	});

	test("denies plainly when the feedback box is dismissed", async () => {
		const handler = makePi();
		const { ctx } = makeCtx({}, {
			select: async () => "Deny with feedback",
			input: async () => undefined,
		});
		const result = await handler({ toolName: "bash", input: { command: "npm test" } }, ctx);
		expect(result?.block).toBe(true);
		expect(result?.reason).not.toContain("Feedback:");
	});

	test("denies plainly when the feedback prompt itself fails", async () => {
		const handler = makePi();
		const { ctx } = makeCtx({}, {
			select: async () => "Deny with feedback",
			input: async () => {
				throw new Error("rpc gone");
			},
		});
		const result = await handler({ toolName: "bash", input: { command: "npm test" } }, ctx);
		expect(result?.block).toBe(true);
		expect(result?.reason).not.toContain("Feedback:");
	});

	test("caps very long deny feedback at five hundred characters", async () => {
		const handler = makePi();
		const { ctx } = makeCtx({}, {
			select: async () => "Deny with feedback",
			input: async () => "x".repeat(600),
		});
		const result = await handler({ toolName: "bash", input: { command: "npm test" } }, ctx);
		expect(result?.block).toBe(true);
		const feedback = result?.reason?.split("Feedback: ")[1] ?? "";
		expect(feedback.length).toBe(500);
		expect(feedback.endsWith("…")).toBe(true);
	});

	test("blocks when the fallback yes-or-no answer is no", async () => {
		const handler = makePi();
		const { ctx } = makeCtx({}, {
			select: async () => {
				throw new Error("no select on this client");
			},
			confirm: async () => false,
		});
		const result = await handler({ toolName: "bash", input: { command: "npm test" } }, ctx);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("Denied by user");
	});

	test("allows when the fallback yes-or-no answer is yes", async () => {
		const handler = makePi();
		const { ctx } = makeCtx({}, {
			select: async () => {
				throw new Error("no select on this client");
			},
			confirm: async () => true,
		});
		expect(await handler({ toolName: "bash", input: { command: "npm test" } }, ctx)).toBeUndefined();
	});

	test("blocks when even the fallback prompt fails", async () => {
		const handler = makePi();
		const { ctx } = makeCtx({}, {
			select: async () => {
				throw new Error("no select");
			},
			confirm: async () => {
				throw new Error("rpc gone");
			},
		});
		const result = await handler({ toolName: "bash", input: { command: "npm test" } }, ctx);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("Denied by user");
	});

	test("blocks without asking when there is no user interface", async () => {
		const handler = makePi();
		let selectCalls = 0;
		const { ctx } = makeCtx({ hasUI: false }, {
			select: async () => {
				selectCalls++;
				return "Allow once";
			},
		});
		const result = await handler({ toolName: "bash", input: { command: "npm test" } }, ctx);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("no UI");
		expect(selectCalls).toBe(0);
	});

	test("asks again after a deny instead of remembering it", async () => {
		const handler = makePi();
		let selectCalls = 0;
		const { ctx } = makeCtx({}, {
			select: async () => {
				selectCalls++;
				return "Deny";
			},
		});
		const event = { toolName: "bash", input: { command: "npm test" } };
		expect((await handler(event, ctx))?.block).toBe(true);
		expect((await handler(event, ctx))?.block).toBe(true);
		expect(selectCalls).toBe(2);
	});

	test("treats an unknown menu choice as a plain deny", async () => {
		const handler = makePi();
		const { ctx } = makeCtx({}, { select: async () => "Maybe later" });
		const result = await handler({ toolName: "bash", input: { command: "npm test" } }, ctx);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("Denied by user");
		expect(result?.reason).not.toContain("Feedback:");
	});
});
