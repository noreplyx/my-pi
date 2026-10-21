/** Smoke tests for the agent-switch extension (mocked ExtensionAPI). */
import { describe, expect, test } from "bun:test";
import factory from "./index.ts";

function makePi() {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const commands = new Map<string, any>();
	const calls: { setActiveTools: string[][]; setModel: unknown[]; status: unknown[] } = {
		setActiveTools: [],
		setModel: [],
		status: [],
	};
	const pi: any = {
		on: (event: string, handler: any) => {
			handlers.set(event, handler);
			return () => {};
		},
		registerCommand: (name: string, options: any) => {
			commands.set(name, options);
		},
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: (tools: string[]) => {
			calls.setActiveTools.push([...tools]);
		},
		getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "edit" }, { name: "write" }],
		setModel: async (model: unknown) => {
			calls.setModel.push(model);
			return true;
		},
	};
	return { pi, handlers, commands, calls };
}

function makeCtx(over: Record<string, any> = {}) {
	const notices: { message: string; type?: string }[] = [];
	const ctx: any = {
		cwd: "/tmp",
		mode: "tui",
		hasUI: true,
		signal: undefined,
		isProjectTrusted: () => true,
		waitForIdle: async () => {},
		modelRegistry: { find: () => undefined },
		ui: {
			notify: (message: string, type?: string) => {
				notices.push({ message, type });
			},
			select: async () => undefined,
			confirm: async () => true,
			setStatus: (...args: unknown[]) => {
				(statusLog as unknown[]).push(args);
			},
			setWidget: (...args: unknown[]) => {
				(widgetLog as unknown[]).push(args);
			},
		},
		...over,
	};
	const statusLog: unknown[][] = [];
	const widgetLog: unknown[][] = [];
	return { ctx, notices, statusLog, widgetLog };
}

function load() {
	const { pi, handlers, commands, calls } = makePi();
	(factory as any)(pi);
	return { pi, handlers, commands, calls };
}

describe("agent-switch", () => {
	test("startup captures defaults; /agent planner switches prompt+tools+env+widget", async () => {
		const { handlers, commands, calls } = load();
		const { ctx, notices, widgetLog } = makeCtx();
		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

		await commands.get("agent").handler("planner", ctx);
		expect(process.env.PI_AGENT_NAME).toBe("planner");
		expect(process.env.PI_AGENT_FILE ?? "").toMatch(/planner\.md$/);
		expect(calls.setActiveTools.at(-1)).toEqual(["read"]);
		expect(widgetLog.at(-1)?.[1]).toEqual(["agent: planner"]);

		const event: any = { systemPromptOptions: { sections: {} } };
		await handlers.get("before_agent_start")(event, ctx);
		expect(event.systemPromptOptions.sections["agent"]).toContain("planning agent");
		expect(notices.at(-1)?.type).toBe("info");

		// Cleanup for other tests.
		await commands.get("agent").handler("reset", ctx);
		expect(process.env.PI_AGENT_NAME).toBeUndefined();
		expect(calls.setActiveTools.at(-1)).toEqual(["read", "bash", "edit", "write"]);
		expect(widgetLog.at(-1)?.[1]).toBeUndefined();
	});

	test("unknown agent is fail-closed", async () => {
		const { handlers, commands, calls } = load();
		const { ctx, notices } = makeCtx();
		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		const before = calls.setActiveTools.length;
		await commands.get("agent").handler("nope", ctx);
		expect(notices.at(-1)?.type).toBe("error");
		expect(calls.setActiveTools.length).toBe(before);
		expect(process.env.PI_AGENT_NAME).toBeUndefined();
	});

	test("picker path switches to the selected label", async () => {
		const { handlers, commands } = load();
		const { ctx } = makeCtx({
			ui: undefined,
		});
		// Rebuild ctx with a select mock that picks coder.
		const { ctx: ctx2, notices } = makeCtx();
		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx2);
		(ctx2.ui as any).select = async (_title: string, options: string[]) =>
			options.find((o) => o.startsWith("coder")) ?? options[0];
		await commands.get("agent").handler("", ctx2);
		expect(process.env.PI_AGENT_NAME).toBe("coder");
		expect(ctx).toBeDefined();
		expect(notices.at(-1)?.type).toBe("info");
		await commands.get("agent").handler("reset", ctx2);
	});

	test("reload clears a previous switch (session-only)", async () => {
		const { handlers, commands } = load();
		const { ctx } = makeCtx();
		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		await commands.get("agent").handler("reviewer", ctx);
		expect(process.env.PI_AGENT_NAME).toBe("reviewer");
		await handlers.get("session_start")({ type: "session_start", reason: "reload" }, ctx);
		expect(process.env.PI_AGENT_NAME).toBeUndefined();
	});

	test("shutdown clears identity", async () => {
		const { handlers, commands } = load();
		const { ctx } = makeCtx();
		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		await commands.get("agent").handler("tester", ctx);
		expect(process.env.PI_AGENT_NAME).toBe("tester");
		await handlers.get("session_shutdown")({ type: "session_shutdown" }, ctx);
		expect(process.env.PI_AGENT_NAME).toBeUndefined();
	});
});
