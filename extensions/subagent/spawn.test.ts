import { describe, expect, mock, test } from "bun:test";
import * as realChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as os from "node:os";

interface FakeProc extends EventEmitter {
	stdout: EventEmitter;
	stderr: EventEmitter;
	pid: undefined;
	killed: boolean;
	killSignals: Array<string | undefined>;
	kill: (sig?: string) => boolean;
}

let behavior: ((proc: FakeProc) => void) | null = null;

const spawnMock = mock((_cmd: string, _args: string[], _opts: unknown) => {
	const proc = new EventEmitter() as FakeProc;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.pid = undefined;
	proc.killed = false;
	proc.killSignals = [];
	proc.kill = (sig?: string) => {
		proc.killed = true;
		proc.killSignals.push(sig);
		// Simulate the OS delivering SIGTERM: the child exits shortly after.
		setTimeout(() => proc.emit("close", 143), 5);
		return true;
	};
	// Run after runSingleAgent has attached its listeners.
	setTimeout(() => behavior?.(proc), 0);
	return proc;
});

mock.module("node:child_process", () => ({ ...realChildProcess, spawn: spawnMock }));

const { runSingleAgent } = await import("./index.ts");

const agents: any[] = [
	{
		name: "coder",
		description: "d",
		tools: ["read"],
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

describe("runSingleAgent process lifecycle (mocked spawn)", () => {
	test("success returns ok with output and duration", async () => {
		behavior = (proc) => {
			proc.stdout.emit("data", msgLine("hello"));
			setTimeout(() => proc.emit("close", 0), 5);
		};
		const r = await runSingleAgent(os.tmpdir(), {}, agents, "coder", "do it", undefined, undefined, undefined, undefined, makeDetails);
		expect(r.errorCode).toBe("ok");
		expect(r.exitCode).toBe(0);
		expect(r.timedOut).toBe(false);
		expect(r.durationMs).toBeGreaterThanOrEqual(0);
		expect(r.messages.length).toBe(1);
	});

	test("timeout kills, keeps partial output, marks timedOut", async () => {
		behavior = (proc) => {
			proc.stdout.emit("data", msgLine("partial"));
			// Never closes on its own; proc.kill() emits close(143).
		};
		const r = await runSingleAgent(os.tmpdir(), {}, agents, "coder", "hang", undefined, undefined, undefined, undefined, makeDetails, undefined, {
			timeoutMs: 60,
		});
		expect(r.errorCode).toBe("timeout");
		expect(r.timedOut).toBe(true);
		expect(r.messages.length).toBe(1);
		expect(r.stderr).toContain("timeout after");
		expect(r.durationMs).toBeGreaterThanOrEqual(40);
	});

	test("spawn failure surfaces spawn-failed", async () => {
		behavior = (proc) => {
			proc.emit("error", new Error("spawn pi ENOENT"));
		};
		const r = await runSingleAgent(os.tmpdir(), {}, agents, "coder", "x", undefined, undefined, undefined, undefined, makeDetails);
		expect(r.errorCode).toBe("spawn-failed");
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("ENOENT");
	});

	test("non-zero exit without error stop is non-zero", async () => {
		behavior = (proc) => {
			setTimeout(() => proc.emit("close", 1), 5);
		};
		const r = await runSingleAgent(os.tmpdir(), {}, agents, "coder", "x", undefined, undefined, undefined, undefined, makeDetails);
		expect(r.errorCode).toBe("non-zero");
		expect(r.timedOut).toBe(false);
	});

	test("user abort throws", async () => {
		const ctl = new AbortController();
		behavior = () => {
			setTimeout(() => ctl.abort(), 10);
		};
		await expect(
			runSingleAgent(os.tmpdir(), {}, agents, "coder", "x", undefined, undefined, ctl.signal, undefined, makeDetails, undefined, {
				timeoutMs: 10000,
			}),
		).rejects.toThrow("Subagent was aborted");
	});
});
