/**
 * Parallel orchestrator: run N tasks with concurrency limit + retry.
 *
 * No-timeout policy: no total budget is enforced. Legacy timeout params
 * (task timeoutMs/questionTimeoutMs, opts fallback/total/question) are
 * accepted for back-compat and ignored. The AbortSignal is the only
 * cancellation source; onError=abort drains the queue (no new starts,
 * in-flight tasks run to completion).
 */
import type { AgentConfig } from "./agents.ts";
import { createQuestionLock } from "./questions.ts";
import { runWithRetry } from "./resilience.ts";
import { runSingleAgent } from "./single.ts";
import type { DispatchDefaults, OnUpdateCallback, ParentUI, SingleResult } from "./types.ts";
import type { ForwardedPermissionStore } from "./forwarded-permissions.ts";
import {
	MAX_CONCURRENCY,
	RESULT_RUNNING,
	emptyUsage,
	getFinalOutput,
	isFailedResult,
	mapWithConcurrencyLimit,
	truncateParallelOutput,
	formatDuration,
} from "./utils.ts";

export interface ParallelTaskInput {
	agent: string;
	task: string;
	cwd?: string;
	/** @deprecated Ignored: accepted for back-compat only. No wall-clock budget. */
	timeoutMs?: number;
	allowQuestions?: boolean;
	/** @deprecated Ignored: accepted for back-compat only. Questions wait indefinitely. */
	questionTimeoutMs?: number;
}

export interface ParallelOptions {
	/** @deprecated Ignored: accepted for back-compat only. No wall-clock budget. */
	fallbackTimeoutMs?: number;
	retryAttempts?: number;
	retryBackoffMs?: number;
	/** @deprecated Ignored: accepted for back-compat only. No total budget. */
	totalTimeoutMs?: number;
	onError?: "abort" | "continue";
	allowQuestions?: boolean;
	/** @deprecated Ignored: accepted for back-compat only. Questions wait indefinitely. */
	questionTimeoutMs?: number;
}

export interface ParallelDeps {
	defaultCwd: string;
	dispatchDefaults: DispatchDefaults;
	agents: AgentConfig[];
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	makeDetails: (results: SingleResult[]) => any;
	parentUI?: ParentUI;
	forwardedPermissions?: ForwardedPermissionStore;
}

function skippedResult(t: ParallelTaskInput, defaultCwd: string, reason: string): SingleResult {
	return {
		agent: t.agent,
		agentSource: "unknown",
		task: t.task,
		cwd: defaultCwd,
		exitCode: 1,
		messages: [],
		stderr: reason,
		usage: emptyUsage(),
		stopReason: "aborted",
		errorMessage: reason,
		errorCode: "aborted",
		timedOut: false,
		durationMs: 0,
		attempts: 0,
	};
}

export async function runParallel(
	tasks: ParallelTaskInput[],
	opts: ParallelOptions,
	deps: ParallelDeps,
): Promise<{ results: SingleResult[]; successCount: number; text: string; allFailed: boolean }> {
	const { defaultCwd, dispatchDefaults, agents, signal, onUpdate, makeDetails, parentUI, forwardedPermissions } = deps;
	// No-timeout policy: opts.totalTimeoutMs is accepted and ignored (no deadline).
	const onError = opts.onError ?? "continue";
	// Drain-only fail-fast: once a task fails with onError=abort, no new
	// tasks start; in-flight tasks run to completion (never killed).
	let failedFast = false;
	// Per-run FIFO question lock: workers in this run serialize dialogs without blocking other runs or single-mode (global lock). Questions wait indefinitely until user abort.
	const questionLock = createQuestionLock();
	const allResults: SingleResult[] = new Array(tasks.length);
	for (let i = 0; i < tasks.length; i++) {
		allResults[i] = {
			agent: tasks[i].agent,
			agentSource: "unknown",
			task: tasks[i].task,
			cwd: defaultCwd,
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
				content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
				details: makeDetails([...allResults]),
			} as any);
		}
	};

	const results = await mapWithConcurrencyLimit(
		tasks,
		MAX_CONCURRENCY,
		async (t, index) => {
			let result: SingleResult;
			const taskStartedAt = Date.now();
			try {
				if (signal?.aborted) throw new Error("Subagent was aborted");
				// No total budget: every task runs until settled or signal aborts.
				const { result: r, attempts } = await runWithRetry(
					() =>
							runSingleAgent(
								defaultCwd,
								dispatchDefaults,
								agents,
								t.agent,
								t.task,
								t.cwd,
								undefined,
								signal,
								(partial) => {
									if (partial.details?.results[0]) {
										allResults[index] = partial.details.results[0];
										emitParallelUpdate();
									}
								},
								makeDetails,
								undefined,
								{
									allowQuestions: t.allowQuestions ?? opts.allowQuestions ?? true,
									parentUI,
									forwardedPermissions,
									questionLock,
									labelPrefix: `[parallel ${t.agent}]`,
								},
							),
						{ attempts: opts.retryAttempts, backoffMs: opts.retryBackoffMs, signal },
					);
					result = { ...r, attempts };
			} catch (e) {
				if (signal?.aborted || (e as Error)?.message === "Subagent was aborted") throw e;
				result = {
					agent: t.agent,
					agentSource: "unknown",
					task: t.task,
					cwd: defaultCwd,
					exitCode: 1,
					messages: [],
					stderr: `Task failed before completion: ${(e as Error)?.message ?? e}`,
					usage: emptyUsage(),
					stopReason: "error",
					errorMessage: (e as Error)?.message ?? String(e),
					errorCode: "non-zero",
					timedOut: false,
					durationMs: Date.now() - taskStartedAt,
					attempts: 1,
				};
			}
			allResults[index] = result;
			emitParallelUpdate();
			if (onError === "abort" && isFailedResult(result) && result.errorCode !== "aborted")
				failedFast = true;
			return result;
		},
		() => (signal?.aborted ?? false) || (onError === "abort" && failedFast),
		(t, index) => {
			let skipped: SingleResult;
			if (signal?.aborted) {
				skipped = skippedResult(t, defaultCwd, "Task skipped: aborted before start.");
			} else {
				skipped = skippedResult(
					t,
					defaultCwd,
					"Task skipped: onError=abort stopped queue after earlier failure."
				);
			}
			allResults[index] = skipped;
			return skipped;
		},
	);

	const successCount = results.filter((r) => !isFailedResult(r)).length;
	const summaries = results.map((r) => {
		const output = truncateParallelOutput(
			r.errorCode !== "ok" && r.errorMessage ? r.errorMessage : getFinalOutput(r.messages) || r.stderr || "(no output)",
		);
		const status = isFailedResult(r)
			? `failed [${r.errorCode}]${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}${r.timedOut ? " timed out" : ""} ⏱ ${formatDuration(r.durationMs)}`
			: `completed ⏱ ${formatDuration(r.durationMs)}`;
		return `### [${r.agent}] ${status}\n\n${output}`;
	});
	const allFailed = successCount === 0 && results.length > 0;
	const earlyStop = onError === "abort" && failedFast ? " (stopped early: onError=abort, in-flight drained)" : "";
	return {
		results,
		successCount,
		text: `Parallel: ${successCount}/${results.length} succeeded${earlyStop}\n\n${summaries.join("\n\n---\n\n")}`,
		allFailed,
	};
}
