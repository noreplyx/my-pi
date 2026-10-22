/**
 * Background bash extension.
 *
 * - Overrides the built-in `bash` tool with the same foreground behavior plus
 *   a `background` flag.
 * - `backgroundAuto: true` in settings.json => EVERY bash call is
 *   auto-backgrounded (returns a job id immediately, wakes the agent on exit).
 * - `backgroundAuto: false` (default) => foreground unless the model passes
 *   `background: true` or the user runs `/bg run <cmd>`.
 *
 * Settings key (user chose): top-level `"backgroundAuto": boolean` in
 * `<agentDir>/settings.json`, project `.pi/settings.json` overrides it.
 * Also accepts `{ "background": { "enabled": bool } }` as an alias.
 *
 * Toggle at runtime: `/background [on|off|status] [--persist]`.
 * Inspect: `/bg [list|log <id>|kill <id>|run <cmd>]`, tools `bg_list`,
 * `bg_output`, `bg_stop`, `bg_run`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	createLocalBashOperations,
	getAgentDir,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { extractAuto } from "./settings.ts";

// ---------------------------------------------------------------- state

let autoBackground = false;
let jobCounter = 0;
let piRef: ExtensionAPI | null = null;
let poller: NodeJS.Timeout | null = null;

type JobStatus = "running" | "done" | "failed" | "killed";

interface Job {
	id: string;
	command: string;
	cwd: string;
	pid?: number;
	logPath: string;
	startTime: number;
	endTime?: number;
	status: JobStatus;
	exitCode?: number;
	notified: boolean;
	timeoutTimer?: NodeJS.Timeout;
	child?: ChildProcess;
}

const jobs = new Map<string, Job>();

const LOG_TAIL_BYTES = 32 * 1024;
const WAKE_TAIL_BYTES = 8 * 1024;
const MAX_LOG_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------- settings

function readJsonFile(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return undefined;
	}
}

function loadAutoFromFiles(cwd: string): boolean {
	const userFile = path.join(getAgentDir(), "settings.json");
	const projectFile = path.join(cwd, ".pi", "settings.json");
	let value = false;
	const user = extractAuto(readJsonFile(userFile));
	if (user !== undefined) value = user;
	const project = extractAuto(readJsonFile(projectFile));
	if (project !== undefined) value = project;
	return value;
}

function resolveAuto(pi: ExtensionAPI, cwd: string): boolean {
	// CLI flag wins when explicitly set.
	try {
		const flag = pi.getFlag("background-auto");
		if (typeof flag === "boolean") return flag;
	} catch {
		// flag not registered yet / unavailable — fall through
	}
	// Effective settings (may carry the custom key at runtime even though
	// it is not part of the typed Settings schema).
	try {
		const s = pi.getSettings() as unknown as Record<string, unknown>;
		const fromSettings = extractAuto(s);
		if (fromSettings !== undefined) return fromSettings;
	} catch {
		// fall through to file read
	}
	return loadAutoFromFiles(cwd);
}

function userSettingsPath(): string {
	return path.join(getAgentDir(), "settings.json");
}

async function persistAuto(value: boolean): Promise<void> {
	const file = userSettingsPath();
	await withFileMutationQueue(file, async () => {
		const { readFile, writeFile, mkdir } = await import("node:fs/promises");
		let raw: Record<string, unknown> = {};
		try {
			raw = JSON.parse(await readFile(file, "utf-8")) as Record<string, unknown>;
		} catch {
			raw = {};
		}
		raw.backgroundAuto = value;
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
	});
}

// ---------------------------------------------------------------- jobs

function logDir(): string {
	return path.join(getAgentDir(), "background", "logs");
}

function ensureLogDir(): void {
	fs.mkdirSync(logDir(), { recursive: true });
}

function nextId(): string {
	jobCounter += 1;
	return `bg-${jobCounter}`;
}

function readTail(file: string, maxBytes: number): string {
	try {
		const stat = fs.statSync(file);
		const start = Math.max(0, stat.size - maxBytes);
		const fd = fs.openSync(file, "r");
		try {
			const len = Math.min(stat.size - start, maxBytes);
			if (len <= 0) return "";
			const buf = Buffer.alloc(len);
			fs.readSync(fd, buf, 0, len, start);
			return buf.toString("utf-8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return "";
	}
}

function notifyCompletion(job: Job): void {
	if (job.notified || !piRef) return;
	job.notified = true;
	const tail = readTail(job.logPath, WAKE_TAIL_BYTES);
	const outcome =
		job.status === "done"
			? `exit ${job.exitCode ?? 0}`
			: job.status === "killed"
				? `killed${job.exitCode !== undefined ? ` (exit ${job.exitCode})` : ""}`
				: `failed${job.exitCode !== undefined ? ` (exit ${job.exitCode})` : ""}`;
	try {
		piRef.sendUserMessage(
			`[background] task ${job.id} finished: ${outcome}\n$ ${job.command}\n--- output tail ---\n${tail || "(no output)"}\n---\nFull log: ${job.logPath}`,
			{ deliverAs: "steer" },
		);
	} catch {
		// headless / print mode — wake is best-effort; output stays in the log
	}
}

function finishJob(job: Job, status: JobStatus, exitCode?: number): void {
	if (job.status !== "running") return;
	job.status = status;
	job.exitCode = exitCode;
	job.endTime = Date.now();
	if (job.timeoutTimer) {
		clearTimeout(job.timeoutTimer);
		job.timeoutTimer = undefined;
	}
	try {
		fs.appendFileSync(job.logPath, `\n[background] ${job.id} ${status}${exitCode !== undefined ? ` exit=${exitCode}` : ""}\n`);
	} catch {
		// ignore
	}
	notifyCompletion(job);
	refreshStatus();
}

function startPoller(): void {
	if (poller) return;
	poller = setInterval(() => {
		for (const job of jobs.values()) {
			if (job.status !== "running") continue;
			// Timeout handled by per-job timer; poller enforces log-size cap.
			try {
				const size = fs.statSync(job.logPath).size;
				if (size > MAX_LOG_BYTES) {
					killJob(job.id, "log exceeded 64 MiB");
				}
			} catch {
				// log missing — keep waiting for close event
			}
			// If the child handle is gone but no close event arrived
			// (e.g. after reload), detect pid death.
			if (!job.child && job.pid) {
				try {
					process.kill(job.pid, 0);
				} catch {
					finishJob(job, "failed");
				}
			}
		}
	}, 2000);
	poller.unref?.();
}

function stopPoller(): void {
	if (poller) {
		clearInterval(poller);
		poller = null;
	}
}

function killProcessGroup(pid: number): void {
	try {
		if (process.platform === "win32") {
			// No process groups on Windows; best-effort kill.
			process.kill(pid, "SIGTERM");
		} else {
			process.kill(-pid, "SIGTERM");
		}
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// already gone
		}
	}
	setTimeout(() => {
		try {
			if (process.platform === "win32") process.kill(pid, "SIGKILL");
			else process.kill(-pid, "SIGKILL");
		} catch {
			// already gone
		}
	}, 5000).unref?.();
}

export function killJob(id: string, _reason?: string): boolean {
	const job = jobs.get(id);
	if (!job || job.status !== "running") return false;
	if (job.pid) killProcessGroup(job.pid);
	// finishJob runs on close; if close never arrives, force it.
	setTimeout(() => {
		const j = jobs.get(id);
		if (j && j.status === "running") finishJob(j, "killed");
	}, 6000).unref?.();
	return true;
}

function startJob(command: string, cwd: string, timeoutSec?: number, onData?: (s: string) => void): Job {
	ensureLogDir();
	const id = nextId();
	const logPath = path.join(logDir(), `${id}.log`);
	const job: Job = {
		id,
		command,
		cwd,
		logPath,
		startTime: Date.now(),
		status: "running",
		notified: false,
	};
	jobs.set(id, job);

	const header = `$ ${command}\n[cwd: ${cwd}]\n[started: ${new Date(job.startTime).toISOString()}]\n\n`;
	fs.writeFileSync(logPath, header, "utf-8");

	const child = spawn("bash", ["-lc", command], {
		cwd,
		detached: process.platform !== "win32",
		env: { ...process.env },
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	job.child = child;
	job.pid = child.pid;

	const stream = fs.createWriteStream(logPath, { flags: "a" });
	child.stdout?.on("data", (d: Buffer) => {
		stream.write(d);
		onData?.(d.toString("utf-8"));
	});
	child.stderr?.on("data", (d: Buffer) => {
		stream.write(d);
		onData?.(d.toString("utf-8"));
	});
	child.on("error", () => {
		stream.end();
		finishJob(job, "failed");
	});
	child.on("close", (code, signal) => {
		stream.end();
		job.child = undefined;
		if (job.status !== "running") return;
		if (signal) finishJob(job, "killed", 128 + 9);
		else finishJob(job, code === 0 ? "done" : "failed", code ?? 1);
	});
	child.unref?.();

	if (timeoutSec && Number.isFinite(timeoutSec) && timeoutSec > 0) {
		job.timeoutTimer = setTimeout(() => {
			const j = jobs.get(id);
			if (j && j.status === "running") {
				if (j.pid) killProcessGroup(j.pid);
				finishJob(j, "killed");
			}
		}, timeoutSec * 1000);
		job.timeoutTimer.unref?.();
	}

	startPoller();
	return job;
}

// ---------------------------------------------------------------- status UI

function refreshStatus(ctx?: { ui: { setStatus: (k: string, t: string | undefined) => void } }): void {
	const running = [...jobs.values()].filter((j) => j.status === "running").length;
	const text = autoBackground ? `bg:auto${running > 0 ? ` (${running})` : ""}` : running > 0 ? `bg:${running}` : undefined;
	try {
		if (ctx) ctx.ui.setStatus("background", text);
		else {
			// piRef path has no direct UI handle; commands pass ctx explicitly.
		}
	} catch {
		// TUI-only; never break execution
	}
}

// ---------------------------------------------------------------- schemas

const BashParams = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, kills the whole process group)" })),
	background: Type.Optional(
		Type.Boolean({ description: "Run detached in background. Implied when backgroundAuto is on." }),
	),
});

const BgOutputSchema = Type.Object({
	output: Type.String({ description: "Combined stdout and stderr, possibly truncated" }),
	truncated: Type.Boolean(),
	full_output_path: Type.Optional(Type.String({ description: "Full output, when truncated" })),
	exit_code: Type.Number(),
	wall_time_seconds: Type.Number(),
});

function toStructured(
	text: string,
	truncated: boolean,
	logPath: string | undefined,
	exitCode: number,
	startedAt: number,
): { output: string; truncated: boolean; full_output_path?: string; exit_code: number; wall_time_seconds: number } {
	return {
		output: text,
		truncated,
		...(truncated && logPath ? { full_output_path: logPath } : {}),
		exit_code: exitCode,
		wall_time_seconds: Math.round(((Date.now() - startedAt) / 1000) * 10) / 10,
	};
}

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI): void {
	piRef = pi;

	pi.registerFlag("background-auto", {
		description: "Run every bash call in the background (overrides backgroundAuto setting)",
		type: "boolean",
	});

	pi.on("session_start", (event, ctx) => {
		if (event.reason === "startup" || event.reason === "reload") {
			autoBackground = resolveAuto(pi, ctx.cwd);
			jobCounter = 0;
			jobs.clear();
		}
		try {
			const running = [...jobs.values()].filter((j) => j.status === "running").length;
			ctx.ui.setStatus("background", autoBackground ? `bg:auto${running > 0 ? ` (${running})` : ""}` : undefined);
			ctx.ui.setWidget("background", autoBackground ? ["background: auto (all bash is async)"] : undefined, {
				placement: "aboveEditor",
			});
		} catch {
			// non-TUI — ignore
		}
	});

	pi.on("session_shutdown", () => {
		stopPoller();
		for (const job of jobs.values()) {
			if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
			// Leave detached children running so logs survive; drop handles.
			job.child = undefined;
		}
	});

	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections["background"] = autoBackground
			? "Background mode is ON (backgroundAuto:true): every bash call runs detached and returns a job id like bg-1 immediately. Do NOT wait or poll in a loop — continue working; you will be woken with the result. Use bg_output only when you need output now. Pass the default timeout unless the user asked otherwise."
			: "Background mode is OFF (backgroundAuto:false): bash runs in the foreground. To background explicitly, call bash with {background:true} or use bg_run — you get a job id (bg-N) at once and are woken when it finishes. Blocking monitors (tail -f, watch, dev servers) should use background:true.";
	});

	// --- bash override: immediate background when enabled ---
	pi.registerTool({
		name: "bash",
		label: "Bash",
		description:
			"Execute a bash command. Returns stdout+stderr (truncated with full log path when large). " +
			"Pass background:true to run detached and get a job id immediately; you are woken when it finishes. " +
			"When backgroundAuto is on, every call is backgrounded automatically.",
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		promptGuidelines: [
			"background:true starts a detached job (bg-N) and wakes you on completion; bg_output/bg_list/bg_stop inspect it.",
		],
		parameters: BashParams,
		outputSchema: BgOutputSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const shouldBg = autoBackground || params.background === true;
			const startedAt = Date.now();
			const cwd = ctx.cwd;

			if (!shouldBg) {
				const ops = createLocalBashOperations();
				let out = "";
				try {
					const { exitCode } = await ops.exec(params.command, cwd, {
						onData: (d) => {
							const s = d.toString("utf-8");
							out += s;
							if (out.length > 256 * 1024) out = out.slice(-256 * 1024);
							onUpdate?.({
								content: [{ type: "text", text: out.slice(-8000) || "" }],
								details: undefined,
							});
						},
						signal: signal ?? undefined,
						timeout: params.timeout,
					});
					const truncated = out.length > LOG_TAIL_BYTES;
					const text = truncated ? out.slice(-LOG_TAIL_BYTES) : out;
					const body = `${text || "(no output)"}\n[exit ${exitCode}]`;
					return {
						content: [{ type: "text", text: body }],
						structuredContent: toStructured(text || "", truncated, undefined, exitCode ?? 0, startedAt),
						details: undefined,
						isError: (exitCode ?? 0) !== 0,
					};
				} catch (e) {
					const msg = (e as Error)?.message ?? String(e);
					if (msg.startsWith("timeout:")) {
						return {
							content: [{ type: "text", text: `Timeout after ${params.timeout}s: ${params.command}` }],
							structuredContent: toStructured("", false, undefined, 124, startedAt),
							details: undefined,
							isError: true,
						};
					}
					if (msg === "aborted") throw e;
					return {
						content: [{ type: "text", text: `Error: ${msg}` }],
						structuredContent: toStructured(msg, false, undefined, 1, startedAt),
						details: undefined,
						isError: true,
					};
				}
			}

			// Background path: immediate return with job id.
			const job = startJob(params.command, cwd, params.timeout, (s) => {
				onUpdate?.({ content: [{ type: "text", text: s.slice(-4000) }], details: undefined });
			});
			const text =
				`Started in background as ${job.id} (pid ${job.pid ?? "?"}). ` +
				`Continue working — you will be woken when it finishes. ` +
				`Use bg_output {"id":"${job.id}"} to check now. Log: ${job.logPath}`;
			if (ctx.hasUI) refreshStatus(ctx);
			return {
				content: [{ type: "text", text }],
				structuredContent: toStructured(text, false, job.logPath, 0, startedAt),
				details: undefined,
			};
		},
	});

	// --- explicit background tool (works in both modes) ---
	// Delegates to the `bash` tool via ctx.executeTool so permission
	// enforcement (tool_call handlers) applies exactly as for direct
	// bash calls — bg_run must never bypass `bash` deny rules.
	pi.registerTool({
		name: "bg_run",
		label: "Background run",
		description: "Always start a shell command detached in the background. Returns a job id immediately.",
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to execute" }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
		}),
		outputSchema: BgOutputSchema,
		async execute(_id, params, signal, onUpdate, ctx) {
			const outcome = await ctx.executeTool(
				"bash",
				{ command: params.command, background: true, timeout: params.timeout },
				{ signal: signal ?? undefined, onUpdate },
			);
			return outcome.result;
		},
	});

	pi.registerTool({
		name: "bg_list",
		label: "Background list",
		description: "List background jobs of this session with status and runtime.",
		parameters: Type.Object({}),
		async execute() {
			if (jobs.size === 0) return { content: [{ type: "text", text: "No background jobs this session." }], details: undefined };
			const lines = [...jobs.values()].map((j) => {
				const secs = Math.round(((j.endTime ?? Date.now()) - j.startTime) / 1000);
				return `${j.id} [${j.status}] ${secs}s pid=${j.pid ?? "?"} exit=${j.exitCode ?? "-"} :: ${j.command.slice(0, 100)}`;
			});
			return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
		},
	});

	pi.registerTool({
		name: "bg_output",
		label: "Background output",
		description: "Show status plus last output of a background job. Optionally block up to wait seconds.",
		parameters: Type.Object({
			id: Type.String({ description: "Job id, e.g. bg-1" }),
			wait: Type.Optional(Type.Number({ description: "Block up to N seconds for completion (default 0)" })),
			tailBytes: Type.Optional(Type.Number({ description: "Tail bytes to return (default 32000)" })),
		}),
		async execute(_id, params) {
			const job = jobs.get(params.id);
			if (!job) {
				return {
					content: [{ type: "text", text: `Unknown job ${params.id}. Use bg_list.` }],
					details: undefined,
					isError: true,
				};
			}
			if (params.wait && params.wait > 0 && job.status === "running") {
				const deadline = Date.now() + Math.min(params.wait, 120) * 1000;
				while (job.status === "running" && Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, 250));
				}
			}
			const tail = readTail(job.logPath, params.tailBytes ?? LOG_TAIL_BYTES);
			const secs = Math.round(((job.endTime ?? Date.now()) - job.startTime) / 1000);
			const text =
				`${job.id} [${job.status}] ${secs}s pid=${job.pid ?? "?"} exit=${job.exitCode ?? "-"} :: ${job.command}\n` +
				`--- log tail (${job.logPath}) ---\n${tail || "(no output yet)"}`;
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "bg_stop",
		label: "Background stop",
		description: "Stop a running background job (SIGTERM whole process group, then SIGKILL).",
		parameters: Type.Object({
			id: Type.String({ description: "Job id, e.g. bg-1" }),
			reason: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			const ok = killJob(params.id, params.reason);
			return {
				content: [{ type: "text", text: ok ? `Stopping ${params.id}.` : `No running job ${params.id}.` }],
				details: undefined,
				isError: !ok,
			};
		},
	});

	// --- commands ---

	pi.registerCommand("background", {
		description: "Toggle auto-background: /background [on|off|status] [--persist]",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const text = (args ?? "").trim();
			const persist = text.includes("--persist");
			const word = text.replace("--persist", "").trim().toLowerCase();

			const apply = async (value: boolean, label: string) => {
				autoBackground = value;
				if (persist) {
					try {
						await persistAuto(value);
					} catch (e) {
						ctx.ui.notify(`Failed to persist backgroundAuto: ${(e as Error)?.message ?? e}`, "error");
						return;
					}
				}
				try {
					ctx.ui.setStatus("background", autoBackground ? "bg:auto" : undefined);
					ctx.ui.setWidget("background", autoBackground ? ["background: auto (all bash is async)"] : undefined, {
						placement: "aboveEditor",
					});
				} catch {
					// ignore
				}
				ctx.ui.notify(
					`${label}${persist ? " (saved to settings.json)" : ""}. ${autoBackground ? "All bash is now auto-backgrounded." : "Bash is foreground; pass background:true or use /bg run to background."}`,
					"info",
				);
			};

			if (word === "on" || word === "enable" || word === "true") return apply(true, "Background auto-mode ON");
			if (word === "off" || word === "disable" || word === "false") return apply(false, "Background auto-mode OFF");
			const running = [...jobs.values()].filter((j) => j.status === "running").length;
			ctx.ui.notify(
				`backgroundAuto: ${autoBackground ? "on" : "off"} (running: ${running}, total: ${jobs.size})\nUsage: /background [on|off|status] [--persist]`,
				"info",
			);
		},
	});

	pi.registerCommand("bg", {
		description: "Background jobs: /bg [list|log <id>|kill <id>|run <cmd>|on|off]",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const text = (args ?? "").trim();
			if (!text || text === "list") {
				if (jobs.size === 0) {
					ctx.ui.notify("No background jobs this session.", "info");
					return;
				}
				const lines = [...jobs.values()].map((j) => {
					const secs = Math.round(((j.endTime ?? Date.now()) - j.startTime) / 1000);
					return `${j.id} [${j.status}] ${secs}s :: ${j.command.slice(0, 100)}`;
				});
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (text === "on" || text === "off") {
				autoBackground = text === "on";
				try {
					ctx.ui.setStatus("background", autoBackground ? "bg:auto" : undefined);
				} catch {
					// ignore
				}
				ctx.ui.notify(`Background auto-mode ${text.toUpperCase()}.`, "info");
				return;
			}
			const [verb, ...rest] = text.split(/\s+/);
			const restText = rest.join(" ").trim();
			if (verb === "run" && restText) {
				await ctx.waitForIdle().catch(() => {});
				const job = startJob(restText, ctx.cwd);
				ctx.ui.notify(`Started ${job.id} (pid ${job.pid ?? "?"}). Log: ${job.logPath}`, "info");
				return;
			}
			if ((verb === "log" || verb === "show") && rest[0]) {
				const job = jobs.get(rest[0]);
				if (!job) {
					ctx.ui.notify(`Unknown job ${rest[0]}.`, "error");
					return;
				}
				const tail = readTail(job.logPath, LOG_TAIL_BYTES);
				ctx.ui.notify(`${job.id} [${job.status}] :: ${job.command}\n${tail || "(no output yet)"}`, "info");
				return;
			}
			if ((verb === "kill" || verb === "stop") && rest[0]) {
				const ok = killJob(rest[0]);
				ctx.ui.notify(ok ? `Stopping ${rest[0]}.` : `No running job ${rest[0]}.`, ok ? "info" : "warning");
				return;
			}
			ctx.ui.notify("Usage: /bg [list|log <id>|kill <id>|run <cmd>|on|off]", "warning");
		},
	});
}
