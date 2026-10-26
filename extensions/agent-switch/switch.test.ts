/** Smoke tests for the agent-switch extension (mocked ExtensionAPI). */
import { describe, expect, test } from "bun:test";
import factory from "./index.ts";
import { AgentPickerComponent, getAgentSearchText } from "./picker.ts";

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
			custom: async () => undefined,
			select: async () => undefined,
			confirm: async () => true,
			setStatus: (...args: unknown[]) => {
				(statusLog as unknown[]).push(args);
			},
		},
		...over,
	};
	const statusLog: unknown[][] = [];
	return { ctx, notices, statusLog };
}

function load() {
	const { pi, handlers, commands, calls } = makePi();
	(factory as any)(pi);
	return { pi, handlers, commands, calls };
}

describe("agent-switch", () => {
	test("startup captures defaults; /agent code-planner switches prompt+tools+env+status", async () => {
		const { handlers, commands, calls } = load();
		const { ctx, notices, statusLog } = makeCtx();
		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

		await commands.get("agent").handler("code-planner", ctx);
		expect(process.env.PI_AGENT_NAME).toBe("code-planner");
		expect(process.env.PI_AGENT_FILE ?? "").toMatch(/code-planner\.md$/);
		expect(calls.setActiveTools.at(-1)).toEqual(["read", "grep", "bash"]);
		expect(statusLog.at(-1)).toEqual(["agent-switch", "agent:code-planner"]);

		const event: any = { systemPromptOptions: { sections: {} } };
		await handlers.get("before_agent_start")(event, ctx);
		expect(event.systemPromptOptions.sections["agent"]).toContain("You are a planner.");
		expect(notices.at(-1)?.type).toBe("info");

		// Cleanup for other tests.
		await commands.get("agent").handler("reset", ctx);
		expect(process.env.PI_AGENT_NAME).toBeUndefined();
		expect(calls.setActiveTools.at(-1)).toEqual(["read", "bash", "edit", "write"]);
		expect(statusLog.at(-1)).toEqual(["agent-switch", undefined]);
	});

	test("unknown agent without UI is fail-closed", async () => {
		const { handlers, commands, calls } = load();
		const { ctx, notices } = makeCtx({ hasUI: false });
		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		const before = calls.setActiveTools.length;
		await commands.get("agent").handler("nope", ctx);
		expect(notices.at(-1)?.type).toBe("error");
		expect(calls.setActiveTools.length).toBe(before);
		expect(process.env.PI_AGENT_NAME).toBeUndefined();
	});

	test("unknown agent with UI opens the picker seeded with the query", async () => {
		const { handlers, commands } = load();
		const { ctx } = makeCtx();
		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		let captured: any;
		(ctx.ui as any).custom = async (factory: any) => {
			let out: any;
			const stubTui = { requestRender: () => {} };
			const stubTheme = {
				fg: (_c: string, s: string) => s,
				bold: (s: string) => s,
			};
			captured = factory(stubTui, stubTheme, undefined, (v: any) => {
				out = v;
			});
			return out;
		};
		// Dismiss the seeded picker: fail closed, no change.
		await commands.get("agent").handler("nope", ctx);
		expect(process.env.PI_AGENT_NAME).toBeUndefined();
		// The picker was seeded with the typed query (mirrors /model <term>).
		expect(captured.getSearchInput().getValue()).toBe("nope");
	});

	test("picker path switches to the selected item", async () => {
		const { handlers, commands } = load();
		const { ctx } = makeCtx({
			ui: undefined,
		});
		// Rebuild ctx with a custom mock that drives the real picker
		// component: type "reviewer" and pick the top filtered match.
		const { ctx: ctx2, notices } = makeCtx();
		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx2);
		(ctx2.ui as any).custom = async (factory: any) => {
			let out: any;
			const stubTui = { requestRender: () => {} };
			const stubTheme = {
				fg: (_c: string, s: string) => s,
				bold: (s: string) => s,
			};
			const component = factory(stubTui, stubTheme, undefined, (v: any) => {
				out = v;
			});
			for (const ch of "reviewer") component.handleInput(ch);
			const match = (component as any).filtered.find((i: any) =>
				i.agent?.name === "code-reviewer",
			);
			expect(match).toBeDefined();
			(component as any).handleSelect(match);
			return out;
		};
		await commands.get("agent").handler("", ctx2);
		expect(process.env.PI_AGENT_NAME).toBe("code-reviewer");
		expect(ctx).toBeDefined();
		expect(notices.at(-1)?.type).toBe("info");
		await commands.get("agent").handler("reset", ctx2);
	});

	test("picker dismiss is fail-closed", async () => {
		const { handlers, commands, calls } = load();
		const { ctx } = makeCtx();
		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		const before = calls.setActiveTools.length;
		// Default custom mock returns undefined (dismissed).
		await commands.get("agent").handler("", ctx);
		expect(process.env.PI_AGENT_NAME).toBeUndefined();
		expect(calls.setActiveTools.length).toBe(before);
	});

	test("picker search text covers name, source, and description", () => {
		const item = {
			label: "code-reviewer",
			agent: {
				name: "code-reviewer",
				source: "user",
				description: "Reviews diffs for bugs",
			} as any,
		};
		const text = getAgentSearchText(item).toLowerCase();
		expect(text).toContain("code-reviewer");
		expect(text).toContain("user");
		expect(text).toContain("reviews diffs");
		const reset = getAgentSearchText({ label: "default", agent: null }).toLowerCase();
		expect(reset).toContain("reset");
	});

	test("AgentPickerComponent filters and resets selection like the model picker", () => {
		const stubTui = { requestRender: () => {} };
		const stubTheme = {
			fg: (_c: string, s: string) => s,
			bold: (s: string) => s,
		};
		const items = [
			{ label: "default", agent: null },
			{ label: "code-planner", agent: { name: "code-planner", source: "user", description: "Plans work" } as any },
			{ label: "code-reviewer", agent: { name: "code-reviewer", source: "user", description: "Reviews code" } as any },
		];
		let selected: any = "unset";
		const component = new AgentPickerComponent(
			stubTui as any,
			stubTheme as any,
			items,
			undefined,
			(v) => {
				selected = v;
			},
			() => {
				selected = undefined;
			},
		);
		expect((component as any).filtered.length).toBe(3);
		component.filterAgents("reviewer");
		expect((component as any).filtered.length).toBe(1);
		expect((component as any).filtered[0].agent?.name).toBe("code-reviewer");
		// Filtering moves the highlight to the top match (model parity).
		expect((component as any).selectedIndex).toBe(0);
		component.filterAgents("zzz-no-match");
		expect((component as any).filtered.length).toBe(0);
		component.filterAgents("");
		expect((component as any).filtered.length).toBe(3);
		expect(selected).toBe("unset");
	});

	test("reload clears a previous switch (session-only)", async () => {
		const { handlers, commands } = load();
		const { ctx } = makeCtx();
		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		await commands.get("agent").handler("code-reviewer", ctx);
		expect(process.env.PI_AGENT_NAME).toBe("code-reviewer");
		await handlers.get("session_start")({ type: "session_start", reason: "reload" }, ctx);
		expect(process.env.PI_AGENT_NAME).toBeUndefined();
	});

	test("shutdown clears identity", async () => {
		const { handlers, commands } = load();
		const { ctx } = makeCtx();
		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		await commands.get("agent").handler("code-tester", ctx);
		expect(process.env.PI_AGENT_NAME).toBe("code-tester");
		await handlers.get("session_shutdown")({ type: "session_shutdown" }, ctx);
		expect(process.env.PI_AGENT_NAME).toBeUndefined();
	});

	test("session_start preserves externally injected identity (subagent child)", async () => {
		// The subagent spawner injects PI_AGENT_NAME/FILE before startup.
		// With no in-process /agent switch active, startup (and a later
		// same-process reload) must leave them alone so the permissions
		// layer keeps reading the injected agent instead of main.md.
		const savedName = process.env.PI_AGENT_NAME;
		const savedFile = process.env.PI_AGENT_FILE;
		process.env.PI_AGENT_NAME = "code-reviewer";
		process.env.PI_AGENT_FILE = "/tmp/injected-agent.md";
		try {
			const { handlers } = load();
			const { ctx } = makeCtx();
			await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
			expect(process.env.PI_AGENT_NAME).toBe("code-reviewer");
			expect(process.env.PI_AGENT_FILE).toBe("/tmp/injected-agent.md");
			await handlers.get("session_start")({ type: "session_start", reason: "reload" }, ctx);
			expect(process.env.PI_AGENT_NAME).toBe("code-reviewer");
			expect(process.env.PI_AGENT_FILE).toBe("/tmp/injected-agent.md");
		} finally {
			if (savedName === undefined) delete process.env.PI_AGENT_NAME;
			else process.env.PI_AGENT_NAME = savedName;
			if (savedFile === undefined) delete process.env.PI_AGENT_FILE;
			else process.env.PI_AGENT_FILE = savedFile;
		}
	});

	test("session_shutdown preserves injected identity when no switch is active", async () => {
		const savedName = process.env.PI_AGENT_NAME;
		const savedFile = process.env.PI_AGENT_FILE;
		process.env.PI_AGENT_NAME = "code-reviewer";
		process.env.PI_AGENT_FILE = "/tmp/injected-agent.md";
		try {
			const { handlers } = load();
			const { ctx } = makeCtx();
			await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
			await handlers.get("session_shutdown")({ type: "session_shutdown" }, ctx);
			expect(process.env.PI_AGENT_NAME).toBe("code-reviewer");
			expect(process.env.PI_AGENT_FILE).toBe("/tmp/injected-agent.md");
		} finally {
			if (savedName === undefined) delete process.env.PI_AGENT_NAME;
			else process.env.PI_AGENT_NAME = savedName;
			if (savedFile === undefined) delete process.env.PI_AGENT_FILE;
			else process.env.PI_AGENT_FILE = savedFile;
		}
	});
});
