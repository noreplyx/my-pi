/**
 * Single-agent dispatch: spawn one isolated `pi --mode json` child process.
 *
 * Moved verbatim from index.ts (runSingleAgent + helpers) so orchestrators
 * share it without pulling in the tool wiring.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, formatAgentList } from "./agents.ts";
import type { DispatchDefaults, RunSingleAgentOptions, SingleResult, SwarmCtx } from "./types.ts";
import {
	KILL_GRACE_MS,
	MAX_MESSAGES,
	MAX_SWARM_DEPTH,
	STDERR_CAP,
	STDOUT_CAP,
	STDOUT_LINE_CAP,
	SWARM_ENV_DEPTH,
	SWARM_ENV_DIR,
	SWARM_ENV_ID,
	SWARM_ENV_RUN,
	appendBounded,
	buildChildEnv,
	clampTimeoutMs,
	emptyUsage,
	ensureSwarmTools,
	formatDuration,
	getFinalOutput,
	isFailedResult,
	parseSwarmDepth,
	swarmProtocolSnippet,
	validateModelString,
	validateToolList,
} from "./utils.ts";

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

export async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: AgentToolResult<any>) => void) | undefined,
	makeDetails: (results: SingleResult[]) => any,
	swarmCtx?: SwarmCtx,
	opts?: RunSingleAgentOptions,
): Promise<SingleResult> {
	const startTime = Date.now();
	const timeoutClamp = clampTimeoutMs(opts?.timeoutMs);
	const effectiveTimeoutMs = timeoutClamp.timeoutMs;
	const setupFailed = (stderr: string): SingleResult => ({
		agent: agentName,
		agentSource: "unknown",
		task,
		cwd: defaultCwd,
		exitCode: 1,
		messages: [],
		stderr: timeoutClamp.error ? `${stderr} (invalid timeoutMs: ${timeoutClamp.error})` : stderr,
		usage: emptyUsage(),
		step,
		errorCode: "setup-error",
		timedOut: false,
		durationMs: Date.now() - startTime,
	});
	if (timeoutClamp.error) return setupFailed("Invalid timeoutMs.");
	if (swarmCtx && swarmCtx.depth > MAX_SWARM_DEPTH) {
		return {
			...setupFailed(`Max swarm depth ${MAX_SWARM_DEPTH} exceeded.`),
			stopReason: "error",
			errorMessage: `Max swarm depth ${MAX_SWARM_DEPTH} exceeded.`,
		};
	}
	const agent = agents.find((a) => a.name.toLowerCase() === agentName.toLowerCase());

	const failedResult = (stderr: string): SingleResult => ({
		agent: agentName,
		agentSource: "unknown",
		task,
		cwd: defaultCwd,
		exitCode: 1,
		messages: [],
		stderr,
		usage: emptyUsage(),
		step,
		errorCode: "setup-error",
		timedOut: false,
		durationMs: Date.now() - startTime,
	});

	if (!agent) {
		const { text: available } = formatAgentList(agents, 20);
		return failedResult(`Unknown agent: "${agentName}". Available agents: ${available}.`);
	}

	let resolvedCwd = defaultCwd;
	if (cwd !== undefined) {
		const candidate = path.resolve(defaultCwd, cwd);
		let stat: fs.Stats | null = null;
		try {
			stat = fs.statSync(candidate);
		} catch {
			stat = null;
		}
		if (!stat || !stat.isDirectory()) {
			return {
				...failedResult(`Invalid working directory: "${cwd}" does not exist or is not a directory.`),
				agentSource: agent.source,
			};
		}
		resolvedCwd = candidate;
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const inheritsDispatchConfig = !agent.model;
	const modelCheck = validateModelString(agent.model);
	const dispatchModelCheck: { model?: string; error?: string } = agent.model
		? {}
		: validateModelString(dispatchDefaults.model);
	const modelError = modelCheck.error ?? dispatchModelCheck.error;
	if (modelError) {
		return {
			...failedResult(`Agent "${agent.name}": invalid model (${modelError}).`),
			agentSource: agent.source,
		};
	}
	const model = modelCheck.model ?? dispatchModelCheck.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	const toolCheck = validateToolList(agent.tools);
	if (toolCheck.dropped.length > 0) {
		return {
			...failedResult(
				`Agent "${agent.name}": invalid tool entries (${toolCheck.dropped.join(", ")}). ` +
					`Tool names must be bare identifiers, never flags.`,
			),
			agentSource: agent.source,
		};
	}
	const effectiveTools = swarmCtx ? ensureSwarmTools(toolCheck.tools) : toolCheck.tools;
	if (effectiveTools && effectiveTools.length > 0) args.push("--tools", effectiveTools.join(","));

	let tmpPromptDir: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		cwd: resolvedCwd,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model,
		step,
		errorCode: "ok",
		timedOut: false,
		durationMs: 0,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			args.push("--append-system-prompt", tmp.filePath);
		}

		const fullTask = swarmCtx
			? `Task: ${task}${swarmProtocolSnippet(swarmCtx.swarmDir, swarmCtx.agentId, swarmCtx.runId, swarmCtx.depth)}`
			: `Task: ${task}`;
		args.push("--", fullTask);
		let abortRequested = false;
		let timedOut = false;
		let spawnFailed = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const childExtra: Record<string, string> = {
				PI_AGENT_NAME: agent.name,
				PI_AGENT_FILE: agent.filePath,
			};
			if (swarmCtx) {
				childExtra[SWARM_ENV_DIR] = swarmCtx.swarmDir;
				childExtra[SWARM_ENV_RUN] = swarmCtx.runId;
				childExtra[SWARM_ENV_ID] = swarmCtx.agentId;
				childExtra[SWARM_ENV_DEPTH] = String(swarmCtx.depth);
			} else {
				const parentDepth = parseSwarmDepth(process.env[SWARM_ENV_DEPTH]);
				childExtra[SWARM_ENV_DEPTH] = String(parentDepth);
			}
			const proc = spawn(invocation.command, invocation.args, {
				cwd: resolvedCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
				env: buildChildEnv(process.env, childExtra),
			});
			let stdoutBuffer = "";
			let stdoutTruncated = false;
			let stderrTruncated = false;

			const pushMessage = (msg: Message) => {
				if (currentResult.messages.length >= MAX_MESSAGES) return;
				currentResult.messages.push(msg);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					pushMessage(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							if (usage.totalTokens && usage.totalTokens > currentResult.usage.contextTokens) {
								currentResult.usage.contextTokens = usage.totalTokens;
							}
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					pushMessage(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				const appended = appendBounded(stdoutBuffer, data.toString(), STDOUT_CAP);
				stdoutBuffer = appended.text;
				stdoutTruncated = stdoutTruncated || appended.truncated;
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() || "";
				if (Buffer.byteLength(stdoutBuffer, "utf8") > STDOUT_LINE_CAP) {
					const buf = Buffer.from(stdoutBuffer, "utf8");
					const cut = buf.subarray(buf.length - STDOUT_LINE_CAP);
					let start = 0;
					while (start < cut.length && (cut[start] & 0xc0) === 0x80) start++;
					stdoutBuffer = cut.subarray(start).toString("utf8");
					stdoutTruncated = true;
				}
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				const appended = appendBounded(currentResult.stderr, data.toString(), STDERR_CAP);
				currentResult.stderr = appended.text;
				stderrTruncated = stderrTruncated || appended.truncated;
			});

			let exited = false;
			let killTimer: ReturnType<typeof setTimeout> | null = null;
			let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
			const killGroup = (sig: NodeJS.Signals) => {
				try {
					if (proc.pid !== undefined && process.platform !== "win32") process.kill(-proc.pid, sig);
					else if (proc.pid !== undefined) process.kill(proc.pid, sig);
					else proc.kill(sig);
				} catch {
					try {
						proc.kill(sig);
					} catch {
						/* already gone */
					}
				}
			};
			const cleanupListeners = () => {
				if (signal) signal.removeEventListener("abort", onAbort);
				if (killTimer) {
					clearTimeout(killTimer);
					killTimer = null;
				}
				if (timeoutTimer) {
					clearTimeout(timeoutTimer);
					timeoutTimer = null;
				}
			};

			const escalateKill = () => {
				killTimer = setTimeout(() => {
					if (!exited) killGroup("SIGKILL");
				}, KILL_GRACE_MS);
				killTimer.unref?.();
			};

			const killProc = () => {
				abortRequested = true;
				if (exited) return;
				killGroup("SIGTERM");
				escalateKill();
			};

			const onTimeout = () => {
				if (exited) return;
				timedOut = true;
				abortRequested = true;
				currentResult.stderr += `\n[timeout after ${formatDuration(effectiveTimeoutMs)} (limit ${effectiveTimeoutMs}ms)]`;
				killGroup("SIGTERM");
				escalateKill();
			};

			const onAbort = () => killProc();

			proc.on("close", (code) => {
				exited = true;
				cleanupListeners();
				if (stdoutBuffer.trim()) processLine(stdoutBuffer);
				if (stdoutTruncated) {
					currentResult.stderr += `\n[stdout truncated at ${STDOUT_CAP} bytes]`;
				}
				if (stderrTruncated) {
					currentResult.stderr += `\n[stderr truncated at ${STDERR_CAP} bytes]`;
				}
				if (currentResult.messages.length >= MAX_MESSAGES) {
					currentResult.stderr += `\n[message log capped at ${MAX_MESSAGES} messages]`;
				}
				resolve(code ?? 0);
			});

			proc.on("error", (err) => {
				exited = true;
				spawnFailed = true;
				cleanupListeners();
				currentResult.stderr += `Failed to start agent process: ${err?.message ?? err}`;
				resolve(1);
			});

			if (signal) {
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", onAbort, { once: true });
			}
			timeoutTimer = setTimeout(onTimeout, effectiveTimeoutMs);
			timeoutTimer.unref?.();
		});

		currentResult.exitCode = exitCode;
		currentResult.durationMs = Date.now() - startTime;
		currentResult.timedOut = timedOut;
		if (timedOut) {
			currentResult.errorCode = "timeout";
			currentResult.stopReason = currentResult.stopReason ?? "error";
			currentResult.errorMessage = currentResult.errorMessage ?? `Subagent timed out after ${formatDuration(effectiveTimeoutMs)}.`;
			return currentResult;
		}
		if (abortRequested) {
			currentResult.errorCode = "aborted";
			throw new Error("Subagent was aborted");
		}
		if (spawnFailed) {
			currentResult.errorCode = "spawn-failed";
		} else if (isFailedResult(currentResult)) {
			currentResult.errorCode = currentResult.stopReason === "aborted" ? "aborted" : "non-zero";
		} else {
			currentResult.errorCode = "ok";
		}
		return currentResult;
	} finally {
		if (tmpPromptDir) {
			try {
				await fs.promises.rm(tmpPromptDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}
}
