/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports four modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *   - Swarm: { swarm: { goal, workers: [{ id, agent, task }...], merger? } }
 *     Hierarchical blackboard swarm in <cwd>/.swarm/<runId>/ with depth<=3,
 *     total<=8, concurrency<=4. Workers publish to done/<id>.md + outbox.
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	formatReadLineRange,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentList } from "./agents.ts";
import { appendOutbox, appendTaskLedger, createSwarmRun, listSwarmRuns, pruneSwarmRuns, readDoneFiles } from "./swarm.ts";
import {
	KILL_GRACE_MS,
	MAX_CONCURRENCY,
	MAX_MESSAGES,
	MAX_PARALLEL_TASKS,
	MAX_SWARM_DEPTH,
	MAX_SWARM_TOTAL,
	RESULT_RUNNING,
	STDERR_CAP,
	STDOUT_CAP,
	STDOUT_LINE_CAP,
	SWARM_ENV_DEPTH,
	SWARM_ENV_DIR,
	SWARM_ENV_ID,
	SWARM_ENV_RUN,
	aggregateUsage,
	appendBounded,
	buildChildEnv,
	capPreviousOutput,
	clampTimeoutMs,
	emptyUsage,
	ensureSwarmTools,
	formatDuration,
	formatUsageStats,
	generateRunId,
	getFinalOutput,
	isFailedResult,
	isValidWorkerId,
	mapWithConcurrencyLimit,
	nextSwarmDepth,
	parseSwarmDepth,
	substitutePrevious,
	swarmProtocolSnippet,
	truncateParallelOutput,
	truncateSingleOutput,
	validateModelString,
	validateToolList,
	type SubagentErrorCode,
	type UsageStats,
} from "./utils.ts";

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const lineRange = formatReadLineRange(args.offset, args.limit);
			let text = themeFg("accent", filePath);
			if (lineRange) {
				text += themeFg("warning", lineRange);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

const COLLAPSED_ITEM_COUNT = 10;

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	/** Resolved absolute working directory the agent process ran in. */
	cwd: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	/** Machine-readable cause. "ok" when the process exited 0 without error/abort. */
	errorCode: SubagentErrorCode;
	/** True when the result was produced by the timeout killer (not a user abort). */
	timedOut: boolean;
	/** Wall-clock time for this agent process, ms. */
	durationMs: number;
}

export interface SwarmInfo {
	runId: string;
	swarmDir: string;
	depth: number;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain" | "swarm";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	/** Non-fatal discovery diagnostics (shadowed/skipped agents). */
	warnings: string[];
	swarm?: SwarmInfo;
}

export interface SwarmCtx {
	depth: number;
	swarmDir: string;
	runId: string;
	agentId: string;
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

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

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface RunSingleAgentOptions {
	/** Per-agent wall-clock budget in ms. Undefined → TIMEOUT_DEFAULT_MS (clamped to TIMEOUT_MAX_MS). */
	timeoutMs?: number;
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

	// Resolve + validate the execution directory upfront: it must exist and
	// be a directory. The resolved absolute path is recorded on the result
	// for auditability.
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
	// Agent frontmatter is untrusted input: validate `--model`/`--tools`
	// so a repo-controlled agent cannot inject extra CLI flags.
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
		// NOTE: the dispatch thinking level only applies when the agent
		// does not pin its own model (agents with a model use that model's
		// default thinking).
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
	// Swarm workers need blackboard + recursion tools even when frontmatter is restrictive.
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

		// `--` guards the task positional: a task starting with `-`
		// (e.g. `--help`) must never be parsed as a CLI flag.
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
				// Root dispatch runs at depth 0 so children can recurse with a budget.
				const parentDepth = parseSwarmDepth(process.env[SWARM_ENV_DEPTH]);
				childExtra[SWARM_ENV_DEPTH] = String(parentDepth);
			}
			const proc = spawn(invocation.command, invocation.args, {
				cwd: resolvedCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
				// Minimal allowlist env: never propagate parent secrets
				// (API keys, tokens) into repo-influenced agent contexts.
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
					// Not JSON (child log line?) — ignore for parsing; the
					// raw tail is surfaced via stderr/stdout diagnostics.
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
				// Bound an un-newlined tail: one giant JSON line must not
				// grow stdoutBuffer without bound. Drop oldest bytes (UTF-8
				// safe) and mark truncated.
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
					// `proc.killed` is true immediately after SIGTERM, so
					// escalation must be gated on actual exit, not on it.
					if (!exited) killGroup("SIGKILL");
				}, KILL_GRACE_MS);
				killTimer.unref?.();
			};

			const killProc = () => {
				abortRequested = true;
				if (exited) return;
				// Process-group kill: children spawned with detached:true form
				// their own pgid, so SIGTERM cascades to recursive grandchildren.
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
				// Surface spawn failures (e.g. `pi` missing from PATH)
				// instead of a generic silent exit 1.
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
		// Best-effort recursive cleanup (a child may have written extra
		// files next to the prompt); never blocks or throws.
		if (tmpPromptDir) {
			try {
				await fs.promises.rm(tmpPromptDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}
}

const TimeoutMsSchema = Type.Optional(
	Type.Number({ description: "Wall-clock budget in ms (default 300000, max 1800000)" }),
);

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	timeoutMs: TimeoutMsSchema,
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	timeoutMs: TimeoutMsSchema,
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SwarmWorker = Type.Object({
	id: Type.String({ description: "Worker ID (lowercase, used for done/<id>.md + inbox/<id>.jsonl)" }),
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the worker" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the worker process" })),
	timeoutMs: TimeoutMsSchema,
});

const SwarmSpec = Type.Object({
	goal: Type.String({ description: "Overall swarm goal recorded in tasks.jsonl" }),
	workers: Type.Array(SwarmWorker, { description: "Workers to run in parallel (max 8)" }),
	merger: Type.Optional(
		Type.Object({
			agent: Type.String({ description: "Agent to synthesize worker outputs" }),
			task: Type.String({ description: "Merger task; {previous} = concatenated done/*.md" }),
			cwd: Type.Optional(Type.String({ description: "Working directory for the merger process" })),
			timeoutMs: TimeoutMsSchema,
		}),
	),
	cleanup: Type.Optional(
		Type.Boolean({ description: "Delete .swarm/<runId>/ when all workers + merger succeed (default false)" }),
	),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	swarm: Type.Optional(SwarmSpec),
	agentScope: Type.Optional(AgentScopeSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	timeoutMs: TimeoutMsSchema,
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder),",
			"swarm ({goal, workers[{id,agent,task}], merger?} hierarchical blackboard in .swarm/<runId>/).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const hasSwarm = Boolean(params.swarm && params.swarm.workers?.length);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle) + Number(hasSwarm);

			const parentDepth = parseSwarmDepth(process.env[SWARM_ENV_DEPTH]);

			const makeDetails =
				(mode: "single" | "parallel" | "chain" | "swarm", swarm?: SwarmInfo) =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
					warnings: discovery.warnings,
					...(swarm ? { swarm } : {}),
				});

			if (modeCount !== 1) {
				const { text: available, remaining } = formatAgentList(agents, 20);
				const more = remaining > 0 ? ` (+${remaining} more)` : "";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}${more}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			// Project-local agents are repo-controlled content: they always
			// require approval on untrusted projects. This gate is enforced
			// server-side (never a model-supplied flag) and fails closed —
			// without a UI to confirm in, untrusted project agents are
			// blocked rather than auto-run.
			if (agentScope === "project" || agentScope === "both") {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);
				if (params.swarm) {
					for (const w of params.swarm.workers) requestedAgentNames.add(w.agent);
					if (params.swarm.merger) requestedAgentNames.add(params.swarm.merger.agent);
				}

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name.toLowerCase() === name.toLowerCase()))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0 && !ctx.isProjectTrusted()) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					if (!ctx.hasUI) {
						return {
							content: [
								{
									type: "text",
									text:
										`Blocked: project-local agents (${names}) from ${dir} require approval, ` +
										`but there is no UI to confirm in. Run with a trusted project or a user-scoped agent.`,
								},
							],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : hasSwarm ? "swarm" : "single")([]),
						};
					}
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : hasSwarm ? "swarm" : "single")([]),
						};
				}
			}

			if (params.swarm && params.swarm.workers.length > 0) {
				const spec = params.swarm;
				if (spec.workers.length > MAX_SWARM_TOTAL)
					return {
						content: [
							{ type: "text", text: `Too many swarm workers (${spec.workers.length}). Max is ${MAX_SWARM_TOTAL}.` },
						],
						details: makeDetails("swarm")([]),
					};
				const seenIds = new Set<string>();
				for (const w of spec.workers) {
					if (!isValidWorkerId(w.id))
						return {
							content: [{ type: "text", text: `Invalid worker id "${w.id}": use lowercase letters, digits, -, _.` }],
							details: makeDetails("swarm")([]),
						};
					const key = w.id.toLowerCase();
					if (seenIds.has(key))
						return {
							content: [{ type: "text", text: `Duplicate worker id "${w.id}".` }],
							details: makeDetails("swarm")([]),
						};
					seenIds.add(key);
				}
				const depthCheck = nextSwarmDepth(parentDepth);
				if ("error" in depthCheck)
					return {
						content: [{ type: "text", text: `Swarm rejected: ${depthCheck.error}.` }],
						details: makeDetails("swarm")([]),
					};
				const workerDepth = depthCheck.depth;
				const runId = generateRunId();
				let run;
				try {
					run = await createSwarmRun(ctx.cwd, runId);
				} catch (e) {
					return {
						content: [{ type: "text", text: `Swarm setup failed: ${(e as Error)?.message ?? e}` }],
						details: makeDetails("swarm")([]),
						isError: true,
					};
				}
				const swarmInfo: SwarmInfo = { runId, swarmDir: run.swarmDir, depth: workerDepth };
				await appendTaskLedger(
					run.swarmDir,
					JSON.stringify({ runId, goal: spec.goal, workers: spec.workers.map((w) => ({ id: w.id, agent: w.agent })) }),
				);
				const allResults: SingleResult[] = new Array(spec.workers.length);
				for (let i = 0; i < spec.workers.length; i++) {
					allResults[i] = {
						agent: spec.workers[i].agent,
						agentSource: "unknown",
						task: spec.workers[i].task,
						cwd: ctx.cwd,
						exitCode: RESULT_RUNNING,
						messages: [],
						stderr: "",
						usage: emptyUsage(),
						errorCode: "ok",
						timedOut: false,
						durationMs: 0,
					};
				}
				const emitSwarmUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === RESULT_RUNNING).length;
						const done = allResults.filter((r) => r.exitCode !== RESULT_RUNNING).length;
						onUpdate({
							content: [{ type: "text", text: `Swarm ${runId}: ${done}/${allResults.length} done, ${running} running...` }],
							details: makeDetails("swarm", swarmInfo)([...allResults]),
						});
					}
				};
				let aborted = false;
				const workerResults = await mapWithConcurrencyLimit(
					spec.workers,
					MAX_CONCURRENCY,
					async (w, index) => {
						let result: SingleResult;
						const workerStartedAt = Date.now();
						try {
							if (signal?.aborted) throw new Error("Subagent was aborted");
							result = await runSingleAgent(
								ctx.cwd,
								dispatchDefaults,
								agents,
								w.agent,
								w.task,
								w.cwd,
								undefined,
								signal,
								(partial) => {
									if (partial.details?.results[0]) {
										allResults[index] = partial.details.results[0];
										emitSwarmUpdate();
									}
								},
								makeDetails("swarm", swarmInfo),
								{ depth: workerDepth, swarmDir: run.swarmDir, runId, agentId: w.id },
								{ timeoutMs: w.timeoutMs ?? params.timeoutMs },
							);
						} catch (e) {
							if (signal?.aborted || (e as Error)?.message === "Subagent was aborted") {
								aborted = true;
								result = {
									agent: w.agent,
									agentSource: "unknown",
									task: w.task,
									cwd: ctx.cwd,
									exitCode: 1,
									messages: [],
									stderr: `Worker ${w.id} aborted.`,
									usage: emptyUsage(),
									stopReason: "aborted",
									errorMessage: "Subagent was aborted",
									errorCode: "aborted",
									timedOut: false,
									durationMs: Date.now() - workerStartedAt,
								};
							} else {
								result = {
									agent: w.agent,
									agentSource: "unknown",
									task: w.task,
									cwd: ctx.cwd,
									exitCode: 1,
									messages: [],
									stderr: `Worker ${w.id} failed before completion: ${(e as Error)?.message ?? e}`,
									usage: emptyUsage(),
									stopReason: "error",
									errorMessage: (e as Error)?.message ?? String(e),
									errorCode: "non-zero",
									timedOut: false,
									durationMs: Date.now() - workerStartedAt,
								};
							}
						}
					allResults[index] = result;
					// Best-effort: persist worker summary to blackboard even on failure.
					try {
						await appendOutbox(
							run.swarmDir,
							JSON.stringify({ ts: new Date().toISOString(), from: w.id, to: "all", body: truncateParallelOutput(getResultOutput(result)).slice(0, 2000) }),
						);
					} catch {
						/* ignore */
					}
					emitSwarmUpdate();
					return result;
					},
					() => signal?.aborted ?? false,
					(w, index) => {
						// Queue drained by abort: synthesize a result so the
						// batch has no holes (holes would crash the summary).
						aborted = true;
						const skipped: SingleResult = {
							agent: w.agent,
							agentSource: "unknown",
							task: w.task,
							cwd: ctx.cwd,
							exitCode: 1,
							messages: [],
							stderr: `Worker ${w.id} skipped: swarm aborted before start.`,
							usage: emptyUsage(),
							stopReason: "aborted",
							errorMessage: "Subagent was aborted",
							errorCode: "aborted",
							timedOut: false,
							durationMs: 0,
						};
						allResults[index] = skipped;
						return skipped;
					},
				);
				if (aborted) {
					return {
						content: [{ type: "text", text: `Swarm ${runId} aborted. Partial: ${workerResults.filter((r) => !isFailedResult(r)).length}/${workerResults.length} succeeded. Blackboard kept at ${run.swarmDir}.` }],
						details: makeDetails("swarm", swarmInfo)(workerResults),
						isError: true,
					};
				}
				const successCount = workerResults.filter((r) => !isFailedResult(r)).length;
				const doneFiles = await readDoneFiles(run.swarmDir).catch(() => []);
				const doneSection =
					doneFiles.length > 0
						? doneFiles.map((d) => `#### done/${d.id}.md\n\n${d.body.slice(0, 4000)}`).join("\n\n---\n\n")
						: workerResults
								.map((r, i) => `#### ${spec.workers[i].id} (${r.agent})\n\n${truncateParallelOutput(getResultOutput(r))}`)
								.join("\n\n---\n\n");
				let mergerOutput = "";
				let mergerResult: SingleResult | null = null;
				if (spec.merger && successCount > 0) {
					if (signal?.aborted) throw new Error("Subagent was aborted");
					mergerResult = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						spec.merger.agent,
						substitutePrevious(spec.merger.task, capPreviousOutput(doneSection)),
						spec.merger.cwd,
						workerResults.length + 1,
						signal,
						onUpdate,
						makeDetails("swarm", swarmInfo),
						{ depth: workerDepth, swarmDir: run.swarmDir, runId, agentId: "merger" },
						{ timeoutMs: spec.merger.timeoutMs ?? params.timeoutMs },
					);
					mergerOutput = getFinalOutput(mergerResult.messages) || "";
				}
				const allForDetails = mergerResult ? [...workerResults, mergerResult] : workerResults;
				const mergerFailed = mergerResult ? isFailedResult(mergerResult) : false;
				if (spec.cleanup && successCount === workerResults.length && !mergerFailed && !signal?.aborted) {
					try {
						await fs.promises.rm(run.swarmDir, { recursive: true, force: true });
					} catch {
						/* best-effort: blackboard kept on cleanup failure */
					}
				}
				const header = `Swarm ${runId}: ${successCount}/${workerResults.length} workers succeeded. Blackboard: ${run.swarmDir}${spec.cleanup && successCount === workerResults.length && !mergerFailed ? " (cleanup requested)" : ""}`;
				const body = mergerResult
					? `${header}\n\n## Merger (${spec.merger?.agent})\n\n${truncateSingleOutput(mergerOutput || "(no output)")}`
					: `${header}\n\n${doneSection.slice(0, 8000)}`;
				return {
					content: [{ type: "text", text: body }],
					details: makeDetails("swarm", swarmInfo)(allForDetails),
					isError: successCount === 0,
				};
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					// An abort during step N must not start step N+1.
					if (signal?.aborted) throw new Error("Subagent was aborted");
					const step = params.chain[i];
					const taskWithContext = substitutePrevious(step.task, capPreviousOutput(previousOutput));

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						undefined,
						{ timeoutMs: step.timeoutMs ?? params.timeoutMs },
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				const finalOutput = getFinalOutput(results[results.length - 1].messages) || "(no output)";
				return {
					content: [{ type: "text", text: truncateSingleOutput(finalOutput) }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						cwd: ctx.cwd,
						exitCode: RESULT_RUNNING,
						messages: [],
						stderr: "",
						usage: emptyUsage(),
						errorCode: "ok",
						timedOut: false,
						durationMs: 0,
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === RESULT_RUNNING).length;
						const done = allResults.filter((r) => r.exitCode !== RESULT_RUNNING).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(
					params.tasks,
					MAX_CONCURRENCY,
					async (t, index) => {
						// Isolate per-task failures: one task throwing (abort,
						// spawn error) must not discard the whole batch.
						let result: SingleResult;
						const taskStartedAt = Date.now();
						try {
							if (signal?.aborted) throw new Error("Subagent was aborted");
							result = await runSingleAgent(
								ctx.cwd,
								dispatchDefaults,
								agents,
								t.agent,
								t.task,
								t.cwd,
								undefined,
								signal,
								// Per-task update callback
								(partial) => {
									if (partial.details?.results[0]) {
										allResults[index] = partial.details.results[0];
										emitParallelUpdate();
									}
								},
								makeDetails("parallel"),
								undefined,
								{ timeoutMs: t.timeoutMs ?? params.timeoutMs },
							);
						} catch (e) {
							if (signal?.aborted || (e as Error)?.message === "Subagent was aborted") throw e;
							result = {
								agent: t.agent,
								agentSource: "unknown",
								task: t.task,
								cwd: ctx.cwd,
								exitCode: 1,
								messages: [],
								stderr: `Task failed before completion: ${(e as Error)?.message ?? e}`,
								usage: emptyUsage(),
								stopReason: "error",
								errorMessage: (e as Error)?.message ?? String(e),
								errorCode: "non-zero",
								timedOut: false,
								durationMs: Date.now() - taskStartedAt,
							};
						}
						allResults[index] = result;
						emitParallelUpdate();
						return result;
					},
					() => signal?.aborted ?? false,
					(t, index) => {
						// Queue drained by abort: synthesize a result so the
						// batch has no holes (holes would crash the summary).
						const skipped: SingleResult = {
							agent: t.agent,
							agentSource: "unknown",
							task: t.task,
							cwd: ctx.cwd,
							exitCode: 1,
							messages: [],
							stderr: "Task skipped: aborted before start.",
							usage: emptyUsage(),
							stopReason: "aborted",
							errorMessage: "Subagent was aborted",
							errorCode: "aborted",
							timedOut: false,
							durationMs: 0,
						};
						allResults[index] = skipped;
						return skipped;
					},
				);

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed [${r.errorCode}]${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}${r.timedOut ? " timed out" : ""} ⏱ ${formatDuration(r.durationMs)}`
						: `completed ⏱ ${formatDuration(r.durationMs)}`;
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				// isError only when nothing succeeded: partial success still
				// carries usable output, and the header reports exact counts.
				const allFailed = successCount === 0 && results.length > 0;
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
					isError: allFailed,
				};
			}

			if (params.agent && params.task) {
				const timeoutCheck = clampTimeoutMs(params.timeoutMs);
				if (timeoutCheck.error) {
					return {
						content: [{ type: "text", text: `Invalid timeoutMs: ${timeoutCheck.error}.` }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
				const result = await runSingleAgent(
					ctx.cwd,
					dispatchDefaults,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					undefined,
					{ timeoutMs: params.timeoutMs },
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: truncateSingleOutput(getFinalOutput(result.messages) || "(no output)") }],
					details: makeDetails("single")([result]),
				};
			}

			const { text: availableFallback, remaining: availableMore } = formatAgentList(agents, 20);
			const moreSuffix = availableMore > 0 ? ` (+${availableMore} more)` : "";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${availableFallback}${moreSuffix}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.swarm && args.swarm.workers?.length > 0) {
				const workers = args.swarm.workers;
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `swarm (${workers.length} workers${args.swarm.merger ? " + merger" : ""})`) +
					theme.fg("muted", ` [${scope}]`);
				for (const w of workers.slice(0, 3)) {
					const preview = w.task.length > 40 ? `${w.task.slice(0, 40)}...` : w.task;
					text += `\n  ${theme.fg("accent", `${w.id}:${w.agent}`)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (workers.length > 3) text += `\n  ${theme.fg("muted", `... +${workers.length - 3} more`)}`;
				if (args.swarm.goal) text += `\n  ${theme.fg("dim", `goal: ${args.swarm.goal.slice(0, 80)}`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);
				const errorBadge =
					isError && (r as SingleResult).errorCode && (r as SingleResult).errorCode !== "ok"
						? ` [${(r as SingleResult).errorCode}]`
						: "";
				const durationBadge =
					(r as SingleResult).durationMs > 0 ? ` ⏱ ${formatDuration((r as SingleResult).durationMs)}` : "";

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}${theme.fg("dim", durationBadge)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]${errorBadge}`)}`;
					else if (errorBadge) header += theme.fg("dim", errorBadge);
					if ((r as SingleResult).timedOut)
						header += ` ${theme.fg("error", "[timed out]")}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}${theme.fg("dim", durationBadge)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]${errorBadge}`)}`;
				else if (errorBadge) text += theme.fg("dim", errorBadge);
				if ((r as SingleResult).timedOut) text += ` ${theme.fg("error", "[timed out]")}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => !isFailedResult(r)).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = !isFailedResult(r) ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					const wallMs = details.results.reduce((a, r) => a + ((r as SingleResult).durationMs || 0), 0);
					if (usageStr || wallMs > 0) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}${wallMs > 0 ? ` | wall ${formatDuration(wallMs)}` : ""}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = !isFailedResult(r) ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					const dur = (r as SingleResult).durationMs > 0 ? ` ⏱ ${formatDuration((r as SingleResult).durationMs)}` : "";
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}${theme.fg("dim", dur)}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				const wallMs = details.results.reduce((a, r) => a + ((r as SingleResult).durationMs || 0), 0);
				if (usageStr || wallMs > 0) text += `\n\n${theme.fg("dim", `Total: ${usageStr}${wallMs > 0 ? ` | wall ${formatDuration(wallMs)}` : ""}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === RESULT_RUNNING).length;
				const successCount = details.results.filter((r) => r.exitCode !== RESULT_RUNNING && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== RESULT_RUNNING && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					const wallMs = Math.max(0, ...details.results.map((r) => (r as SingleResult).durationMs || 0));
					if (usageStr || wallMs > 0) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}${wallMs > 0 ? ` | wall ${formatDuration(wallMs)}` : ""}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === RESULT_RUNNING
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === RESULT_RUNNING ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					const wallMs = Math.max(0, ...details.results.map((r) => (r as SingleResult).durationMs || 0));
					if (usageStr || wallMs > 0) text += `\n\n${theme.fg("dim", `Total: ${usageStr}${wallMs > 0 ? ` | wall ${formatDuration(wallMs)}` : ""}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "swarm") {
				const running = details.results.filter((r) => r.exitCode === RESULT_RUNNING).length;
				const successCount = details.results.filter((r) => r.exitCode !== RESULT_RUNNING && !isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning ? theme.fg("warning", "⏳") : theme.fg("success", "✓");
				const swarmLine = details.swarm ? ` ${details.swarm.runId} @ ${details.swarm.swarmDir}` : "";
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("swarm "))}${theme.fg("accent", `${successCount}/${details.results.length} workers`)}${theme.fg("muted", swarmLine)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === RESULT_RUNNING
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === RESULT_RUNNING ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					const wallMs = Math.max(0, ...details.results.map((r) => (r as SingleResult).durationMs || 0));
					if (usageStr || wallMs > 0) text += `\n\n${theme.fg("dim", `Total: ${usageStr}${wallMs > 0 ? ` | wall ${formatDuration(wallMs)}` : ""}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	pi.registerTool({
		name: "swarm_gc",
		label: "Swarm GC",
		description:
			"List/prune stale .swarm/<runId>/ blackboard dirs. Dry-run by default; pass apply:true to delete. A run is deleted only when older than olderThanDays AND outside the newest keepLastN.",
		parameters: Type.Object({
			olderThanDays: Type.Optional(Type.Number({ description: "Delete runs older than N days (default 7)" })),
			keepLastN: Type.Optional(Type.Number({ description: "Always keep newest N runs (default 10)" })),
			apply: Type.Optional(Type.Boolean({ description: "Actually delete (default false = dry-run)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!params.apply) {
				const runs = await listSwarmRuns(ctx.cwd);
				const preview = await pruneSwarmRuns(ctx.cwd, {
					olderThanDays: params.olderThanDays,
					keepLastN: params.keepLastN,
					dryRun: true,
				});
				const lines = runs.slice(0, 20).map((r) => {
					const age = `${Math.round((Date.now() - r.mtimeMs) / 86400000)}d`;
					const mark = preview.deleted.includes(r.runId) ? " [would delete]" : "";
					return `${r.runId} age=${age} ${(r.sizeBytes / 1024).toFixed(1)}KB${mark}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Swarm runs: ${runs.length}. Would delete ${preview.deleted.length} (${(preview.freedBytes / 1024).toFixed(1)}KB). Pass apply:true to delete.\n${lines.join("\n") || "(no runs)"}`,
						},
					],
					details: { preview } as any,
				};
			}
			const res = await pruneSwarmRuns(ctx.cwd, {
				olderThanDays: params.olderThanDays,
				keepLastN: params.keepLastN,
				dryRun: false,
			});
			return {
				content: [
					{
						type: "text",
						text: res.deleted.length === 0
							? `Swarm GC: nothing to delete (kept ${res.kept.length}).`
							: `Swarm GC: deleted ${res.deleted.length} run(s), freed ${(res.freedBytes / 1024).toFixed(1)}KB. Kept ${res.kept.length}.\n${res.deleted.join("\n")}`,
					},
				],
				details: res as any,
			};
		},
	});

	pi.registerCommand("swarm-gc", {
		description: "Prune stale .swarm/<runId>/ dirs: /swarm-gc [--older-than N] [--keep-last N] [--apply]",
		handler: async (args, ctx) => {
			const text = args ?? "";
			const num = (re: RegExp): number | undefined => {
				const m = text.match(re);
				if (!m) return undefined;
				const n = Number(m[1]);
				return Number.isFinite(n) && n >= 0 ? n : undefined;
			};
			const olderThan = num(/--older-than\s+(\d+(?:\.\d+)?)/) ?? 7;
			const keepLast = num(/--keep-last\s+(\d+)/) ?? 10;
			const apply = text.includes("--apply");
			const res = await pruneSwarmRuns(ctx.cwd, {
				olderThanDays: olderThan,
				keepLastN: keepLast,
				dryRun: !apply,
			});
			const verb = apply ? "Deleted" : "Would delete";
			ctx.ui.notify(
				`Swarm GC (${apply ? "applied" : "dry-run"}): ${verb.toLowerCase()} ${res.deleted.length} run(s)${res.deleted.length > 0 ? `, freed ${(res.freedBytes / 1024).toFixed(1)}KB` : ""}. Kept ${res.kept.length}.\n${res.deleted.slice(0, 20).join("\n")}${res.deleted.length > 20 ? `\n... +${res.deleted.length - 20} more` : ""}${apply ? "" : "\nPass --apply to delete."}`,
				"info",
			);
		},
	});
}
