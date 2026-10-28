/**
 * Single-agent dispatch: spawn one isolated `pi --mode rpc` child process.
 *
 * Option C (interactive forwarding): the child runs as an RPC server with
 * a piped stdin. The parent sends a `prompt` command, streams
 * `message_end` events for the result, forwards `extension_ui_request`
 * (select / confirm / input, from `ask_user` or permission prompts) to
 * the parent `ctx.ui` under a global mutex, and kills the child on
 * `agent_settled`.
 *
 * Frontmatter gating (Q2): `ask_user` is only visible to the child model
 * when the agent's frontmatter `tools:` lists it — enforced by the
 * `--tools` allowlist below, not by force-adding here.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, formatAgentList } from "./agents.ts";
import {
	FORWARDED_SESSION_CHOICES,
	FORWARDED_SESSION_VALUE,
	isPermissionConfirm,
	isPermissionSelect,
	normalizeAgentSegment,
	normalizePermissionKey,
} from "./forwarded-permissions.ts";
import { AUTO_APPROVE_ENV, isAutoApproveEnabled } from "../auto-approve/state.ts";
import { isFireAndForgetMethod, isForwardedMethod, withQuestionLock } from "./questions.ts";
import type { DispatchDefaults, ParentUI, RunSingleAgentOptions, SingleResult, SwarmCtx } from "./types.ts";
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

function safeWriteStdin(proc: { stdin?: { write: (s: string) => unknown; writable?: boolean } | null }, obj: unknown): void {
	try {
		const stdin = proc.stdin as { write: (s: string) => unknown; writable?: boolean } | null | undefined;
		if (!stdin || stdin.writable === false) return;
		stdin.write(`${JSON.stringify(obj)}\n`);
	} catch {
		/* child going away — settled/timeout path owns the outcome */
	}
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
	const allowQuestions = opts?.allowQuestions ?? true;
	const questionTimeoutMs = opts?.questionTimeoutMs;
	const parentUI = opts?.parentUI as ParentUI | undefined;
	const labelPrefix = opts?.labelPrefix;
	const forwardedPermissions = opts?.forwardedPermissions;
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

	const args: string[] = ["--mode", "rpc", "--no-session"];
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
		let abortRequested = false;
		let timedOut = false;
		let spawnFailed = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const childExtra: Record<string, string> = {
				PI_AGENT_NAME: agent.name,
				PI_AGENT_FILE: agent.filePath,
			};
			// Auto-approve inheritance: the child boots a fresh runtime whose
			// in-memory toggle defaults OFF — pass it explicitly so delegated
			// work doesn't re-prompt. Deny rules still block in the child.
			// Grandchildren inherit transitively (child re-propagates from
			// its own enabled state). Explicit per-spawn extra, never a
			// blanket env passthrough (repo-controlled config can't set it).
			if (isAutoApproveEnabled()) childExtra[AUTO_APPROVE_ENV] = "1";
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
				stdio: ["pipe", "pipe", "pipe"],
				detached: true,
				env: buildChildEnv(process.env, childExtra),
			});
			let stdoutBuffer = "";
			let stdoutTruncated = false;
			let stderrTruncated = false;
			let settled = false;
			let resolveOnce = (code: number) => {
				if (settled) return;
				settled = true;
				resolve(code);
			};
			// Reassign to guard double-resolve from close + settled paths.
			resolveOnce = ((orig: (code: number) => void) => {
				let done = false;
				return (code: number) => {
					if (done) return;
					done = true;
					settled = true;
					orig(code);
				};
			})(resolve);

			const pushMessage = (msg: Message) => {
				if (currentResult.messages.length >= MAX_MESSAGES) return;
				currentResult.messages.push(msg);
			};

			const finishSettled = (code: number) => {
				cleanupListeners();
				killGroup("SIGTERM");
				escalateKill();
				resolveOnce(code);
			};

			const forwardUIRequest = (req: any) => {
				const id = req?.id;
				const method = req?.method;
				if (typeof id !== "string" || typeof method !== "string") return;
				if (isFireAndForgetMethod(method)) {
					if (method === "notify" && parentUI?.hasUI) {
						try {
							parentUI.notify(
								`${labelPrefix ? `${labelPrefix} ` : ""}${String(req.message ?? "(notification)").slice(0, 500)}`,
								req.notifyType ?? "info",
							);
						} catch {
							/* never break the child on notify */
						}
					}
					return;
				}
				if (!isForwardedMethod(method)) {
					currentResult.stderr += `\n[question skipped: unsupported method "${method}"]`;
					safeWriteStdin(proc, { type: "extension_ui_response", id, cancelled: true });
					return;
				}
				// Parent-side auto-approve (defense in depth alongside the
				// PI_AUTO_APPROVE env above): a permission dialog forwarded
				// by a child that didn't inherit the toggle (stale code,
				// missed spawn path) is approved here without prompting.
				// Scoped to permission-shaped requests only — ask_user
				// questions still respect allowQuestions/hasUI below.
				// Replies "Allow once" (FORWARDED_SESSION_CHOICES[0]) so
				// nothing is memoized; each prompt is approved individually
				// by the toggle. Child-side deny never reaches us (the
				// child enforces deny itself and never forwards it).
				if (isAutoApproveEnabled() && (isPermissionSelect(req) || isPermissionConfirm(req))) {
					currentResult.stderr += `\n[auto-approve (parent): ${String(req.title ?? method).slice(0, 120)}]`;
					if (method === "confirm") {
						safeWriteStdin(proc, { type: "extension_ui_response", id, confirmed: true });
					} else {
						safeWriteStdin(proc, { type: "extension_ui_response", id, value: FORWARDED_SESSION_CHOICES[0] });
					}
					return;
				}
				if (!allowQuestions || !parentUI?.hasUI) {
					const reason = !parentUI?.hasUI ? "no UI to confirm in" : "questions disabled for this task";
					currentResult.stderr += `\n[question skipped (${reason}): ${String(req.title ?? method).slice(0, 120)}]`;
					if (method === "confirm") {
						safeWriteStdin(proc, { type: "extension_ui_response", id, confirmed: false });
					} else {
						safeWriteStdin(proc, { type: "extension_ui_response", id, cancelled: true });
					}
					return;
				}
				void withQuestionLock(async () => {
					if (settled || signal?.aborted) {
						safeWriteStdin(proc, method === "confirm" ? { type: "extension_ui_response", id, confirmed: false } : { type: "extension_ui_response", id, cancelled: true });
						return;
					}
					// Parent-side session memo: a repeated identical child
					// permission dialog ("Allow for this session" picked
					// before) is auto-approved without re-prompting. Keyed
					// by agent + child cwd + raw child title (titles are
					// cwd-relative summaries, so the cwd scopes the key;
					// the agent scopes it per target agent — agent A's
					// approval never covers agent B. Parallel/swarm label
					// prefixes are added by the parent at display time and
					// never enter the key). Check inside the lock so
					// concurrent workers can't double-prompt.
					const permissionShaped = isPermissionSelect(req);
					const permissionKey = permissionShaped
						? `${normalizeAgentSegment(agentName)}\0${resolvedCwd}\0${normalizePermissionKey(String(req.title ?? ""))}`
						: null;
					if (permissionShaped && permissionKey && forwardedPermissions?.get(permissionKey) === "session") {
						currentResult.stderr += `\n[session-grant (parent): ${permissionKey.slice(0, 120)}]`;
						safeWriteStdin(proc, { type: "extension_ui_response", id, value: FORWARDED_SESSION_VALUE });
						return;
					}
					const title = `${labelPrefix ? `${labelPrefix} ` : `[${agentName}] `}${String(req.title ?? "Subagent question").slice(0, 300)}`;
					const ctrl = new AbortController();
					const onParentAbort = () => ctrl.abort();
					let qTimer: ReturnType<typeof setTimeout> | null = null;
					if (signal) {
						if (signal.aborted) ctrl.abort();
						else signal.addEventListener("abort", onParentAbort, { once: true });
					}
					if (typeof questionTimeoutMs === "number" && Number.isFinite(questionTimeoutMs) && questionTimeoutMs > 0) {
						qTimer = setTimeout(() => ctrl.abort(), Math.floor(questionTimeoutMs));
					}
					try {
						if (method === "select") {
							const options = Array.isArray(req.options) ? req.options.filter((o: unknown) => typeof o === "string").slice(0, 20) : [];
							const picked = await parentUI.select(title, options, { signal: ctrl.signal });
							// Only "Allow for this session" is memoized. "Allow
							// once", Deny, and dismissals re-prompt next time.
							if (permissionShaped && permissionKey && picked === FORWARDED_SESSION_VALUE) {
								forwardedPermissions?.setSession(permissionKey);
							}
							if (picked === undefined) {
								safeWriteStdin(proc, { type: "extension_ui_response", id, cancelled: true });
							} else {
								safeWriteStdin(proc, { type: "extension_ui_response", id, value: picked });
							}
						} else if (method === "confirm") {
							const ok = await parentUI.confirm(title, String(req.message ?? "").slice(0, 2000), { signal: ctrl.signal });
							safeWriteStdin(proc, { type: "extension_ui_response", id, confirmed: ok });
						} else {
							const text = await parentUI.input(title, typeof req.placeholder === "string" ? req.placeholder : undefined, {
								signal: ctrl.signal,
							});
							if (text === undefined) {
								safeWriteStdin(proc, { type: "extension_ui_response", id, cancelled: true });
							} else {
								safeWriteStdin(proc, { type: "extension_ui_response", id, value: text });
							}
						}
					} catch {
						safeWriteStdin(proc, method === "confirm" ? { type: "extension_ui_response", id, confirmed: false } : { type: "extension_ui_response", id, cancelled: true });
					} finally {
						if (qTimer) clearTimeout(qTimer);
						if (signal) signal.removeEventListener("abort", onParentAbort);
					}
				});
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "extension_ui_request") {
					forwardUIRequest(event);
					return;
				}

				if (event.type === "response" && event.command === "prompt") {
					if (event.success === false) {
						currentResult.stderr += `\n[prompt rejected: ${String(event.error ?? "unknown error").slice(0, 500)}]`;
					}
					return;
				}

				if (event.type === "agent_settled") {
					finishSettled(0);
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
				safeWriteStdin(proc, { id: `abort-${Date.now()}`, type: "abort" });
				if (exited) return;
				killGroup("SIGTERM");
				escalateKill();
			};

			const onTimeout = () => {
				if (exited || settled) return;
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
				resolveOnce(code ?? 0);
			});

			proc.on("error", (err) => {
				exited = true;
				spawnFailed = true;
				cleanupListeners();
				currentResult.stderr += `Failed to start agent process: ${err?.message ?? err}`;
				resolveOnce(1);
			});

			if (signal) {
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", onAbort, { once: true });
			}
			timeoutTimer = setTimeout(onTimeout, effectiveTimeoutMs);
			timeoutTimer.unref?.();

			safeWriteStdin(proc, { id: `prompt-${Date.now()}`, type: "prompt", message: fullTask });
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
