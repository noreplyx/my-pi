import { describe, expect, mock, test } from "bun:test";
import * as realChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as os from "node:os";

interface FakeProc extends EventEmitter {
	stdout: EventEmitter;
	stderr: EventEmitter;
	stdin: { writes: string[]; writable: boolean; write: (s: string) => boolean };
	pid: undefined;
	kill: (sig?: string) => boolean;
}

let behavior: ((proc: FakeProc) => void) | null = null;
let lastProc: FakeProc | null = null;
let lastArgs: string[] = [];

const spawnMock = mock((_cmd: string, args: string[], _opts: unknown) => {
	const proc = new EventEmitter() as FakeProc;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	const writes: string[] = [];
	proc.stdin = {
		writes,
		writable: true,
		write: (s: string) => {
			writes.push(s);
			return true;
		},
	};
	proc.pid = undefined;
	proc.kill = () => true;
	lastProc = proc;
	lastArgs = args;
	setTimeout(() => behavior?.(proc), 0);
	return proc;
});

mock.module("node:child_process", () => ({ ...realChildProcess, spawn: spawnMock }));

const { runSingleAgent } = await import("./single.ts");

const agents: any[] = [
	{
		name: "coder",
		description: "d",
		tools: ["read", "ask_user"],
		model: undefined,
		systemPrompt: "",
		source: "user",
		filePath: "/tmp/coder.md",
	},
];

const makeDetails = (results: any[]) => ({ results });

function msgLine(text: string): string {
	return (
		JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 10, output: 5 } },
		}) + "\n"
	);
}

describe("RPC question forwarding", () => {
	test("uses --mode rpc and sends prompt over stdin", async () => {
		behavior = (proc) => {
			proc.stdout.emit("data", msgLine("done"));
			proc.stdout.emit("data", JSON.stringify({ type: "agent_settled", aborted: false }) + "\n");
			setTimeout(() => proc.emit("close", 0), 5);
		};
		const parentUI = {
			hasUI: true,
			select: async () => "x",
			confirm: async () => true,
			input: async () => "y",
			notify: () => {},
		};
		const r = await runSingleAgent(os.tmpdir(), {}, agents, "coder", "do it", undefined, undefined, undefined, undefined, makeDetails, undefined, {
			parentUI: parentUI as any,
		});
		expect(r.errorCode).toBe("ok");
		expect(lastArgs).toContain("rpc");
		expect(lastArgs).not.toContain("json");
		const promptWrite = lastProc!.stdin.writes.find((w) => w.includes('"type":"prompt"'));
		expect(promptWrite).toBeDefined();
		expect(promptWrite!).toContain("do it");
	});

	test("forwards select to parent UI and writes response", async () => {
		let selected: string | undefined;
		behavior = (proc) => {
			proc.stdout.emit("data", JSON.stringify({ type: "extension_ui_request", id: "q1", method: "select", title: "Pick?", options: ["A", "B"] }) + "\n");
			setTimeout(() => {
				proc.stdout.emit("data", msgLine("chose"));
				proc.stdout.emit("data", JSON.stringify({ type: "agent_settled", aborted: false }) + "\n");
				setTimeout(() => proc.emit("close", 0), 5);
			}, 20);
		};
		const parentUI = {
			hasUI: true,
			select: async (title: string, options: string[]) => {
				selected = `${title}:${options.join(",")}`;
				return "B";
			},
			confirm: async () => true,
			input: async () => "y",
			notify: () => {},
		};
		const r = await runSingleAgent(os.tmpdir(), {}, agents, "coder", "ask me", undefined, undefined, undefined, undefined, makeDetails, undefined, {
			parentUI: parentUI as any,
			labelPrefix: "[coder]",
		});
		expect(r.errorCode).toBe("ok");
		expect(selected).toContain("Pick?");
		const resp = lastProc!.stdin.writes.find((w) => w.includes('"q1"'));
		expect(resp).toBeDefined();
		expect(resp!).toContain('"value":"B"');
	});

	test("no-UI auto-dismisses without calling parent", async () => {
		let called = false;
		behavior = (proc) => {
			proc.stdout.emit("data", JSON.stringify({ type: "extension_ui_request", id: "q2", method: "input", title: "Name?" }) + "\n");
			setTimeout(() => {
				proc.stdout.emit("data", msgLine("skipped"));
				proc.stdout.emit("data", JSON.stringify({ type: "agent_settled", aborted: false }) + "\n");
				setTimeout(() => proc.emit("close", 0), 5);
			}, 20);
		};
		const parentUI = {
			hasUI: false,
			select: async () => {
				called = true;
				return "x";
			},
			confirm: async () => true,
			input: async () => {
				called = true;
				return "y";
			},
			notify: () => {},
		};
		const r = await runSingleAgent(os.tmpdir(), {}, agents, "coder", "ask me", undefined, undefined, undefined, undefined, makeDetails, undefined, {
			parentUI: parentUI as any,
		});
		expect(r.errorCode).toBe("ok");
		expect(called).toBe(false);
		const resp = lastProc!.stdin.writes.find((w) => w.includes('"q2"'));
		expect(resp).toContain("cancelled");
		expect(r.stderr).toContain("no UI");
	});

	test("allowQuestions:false auto-dismisses confirm as false", async () => {
		behavior = (proc) => {
			proc.stdout.emit("data", JSON.stringify({ type: "extension_ui_request", id: "q3", method: "confirm", title: "Go?", message: "sure?" }) + "\n");
			setTimeout(() => {
				proc.stdout.emit("data", msgLine("done"));
				proc.stdout.emit("data", JSON.stringify({ type: "agent_settled", aborted: false }) + "\n");
				setTimeout(() => proc.emit("close", 0), 5);
			}, 20);
		};
		const parentUI = {
			hasUI: true,
			select: async () => "x",
			confirm: async () => true,
			input: async () => "y",
			notify: () => {},
		};
		await runSingleAgent(os.tmpdir(), {}, agents, "coder", "ask me", undefined, undefined, undefined, undefined, makeDetails, undefined, {
			parentUI: parentUI as any,
			allowQuestions: false,
		});
		const resp = lastProc!.stdin.writes.find((w) => w.includes('"q3"'));
		expect(resp).toContain('"confirmed":false');
	});
});
