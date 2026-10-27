/**
 * Parallel orchestrator: run N tasks with concurrency limit + retry + total budget.
 */
import type { AgentConfig } from "./agents.ts";
import { runWithRetry, isBudgetExceeded, totalDeadline } from "./resilience.ts";
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
	timeoutMs?: number;
	allowQuestions?: boolean;
	questionTimeoutMs?: number;
}

export interface ParallelOptions {
	fallbackTimeoutMs?: number;
	retryAttempts?: number;
	retryBackoffMs?: number;
	totalTimeoutMs?: number;
	onError?: "abort" | "continue";
	allowQuestions?: boolean;
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

function skippedResult(t: ParallelTaskInput, defaultCwd: string, reason: string, code: "aborted" | "budget-exceeded"): SingleResult {
	return {
		agent: t.agent,
		agentSource: "unknown",
		task: t.task,
		cwd: defaultCwd,
		exitCode: 1,
		messages: [],
		stderr: reason,
		usage: emptyUsage(),
		stopReason: code === "aborted" ? "aborted" : "error",
		errorMessage: reason,
		errorCode: code,
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
	const deadline = totalDeadline(opts.totalTimeoutMs);
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
				if (isBudgetExceeded(deadline)) {
					result = skippedResult(t, defaultCwd, "Task skipped: total budget exceeded before start.", "budget-exceeded");
				} else {
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
									timeoutMs: t.timeoutMs ?? opts.fallbackTimeoutMs,
									allowQuestions: t.allowQuestions ?? opts.allowQuestions ?? true,
									questionTimeoutMs: t.questionTimeoutMs ?? opts.questionTimeoutMs,
									parentUI,
									forwardedPermissions,
									labelPrefix: `[parallel ${t.agent}]`,
								},
							),
						{ attempts: opts.retryAttempts, backoffMs: opts.retryBackoffMs, signal },
					);
					result = { ...r, attempts };
				}
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
			return result;
		},
		() => signal?.aborted ?? isBudgetExceeded(deadline),
		(t, index) => {
			const skipped = isBudgetExceeded(deadline)
				? skippedResult(t, defaultCwd, "Task skipped: total budget exceeded.", "budget-exceeded")
				: skippedResult(t, defaultCwd, "Task skipped: aborted before start.", "aborted");
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
	return {
		results,
		successCount,
		text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
		allFailed,
	};
}
