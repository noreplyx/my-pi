/**
 * Chain orchestrator: sequential steps with {previous} substitution,
 * per-step retry, total budget, and onError continue/abort.
 */
import type { AgentConfig } from "./agents.ts";
import { isBudgetExceeded, runWithRetry, totalDeadline } from "./resilience.ts";
import { runSingleAgent } from "./single.ts";
import type { DispatchDefaults, OnUpdateCallback, SingleResult } from "./types.ts";
import { capPreviousOutput, emptyUsage, getFinalOutput, isFailedResult, substitutePrevious, truncateSingleOutput } from "./utils.ts";

export interface ChainStepInput {
	agent: string;
	task: string;
	cwd?: string;
	timeoutMs?: number;
}

export interface ChainOptions {
	fallbackTimeoutMs?: number;
	retryAttempts?: number;
	retryBackoffMs?: number;
	totalTimeoutMs?: number;
	onError?: "abort" | "continue";
}

export interface ChainDeps {
	defaultCwd: string;
	dispatchDefaults: DispatchDefaults;
	agents: AgentConfig[];
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	makeDetails: (results: SingleResult[]) => any;
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

export async function runChain(
	steps: ChainStepInput[],
	opts: ChainOptions,
	deps: ChainDeps,
): Promise<{ results: SingleResult[]; text: string; isError: boolean }> {
	const { defaultCwd, dispatchDefaults, agents, signal, onUpdate, makeDetails } = deps;
	const onError = opts.onError ?? "abort";
	const deadline = totalDeadline(opts.totalTimeoutMs);
	const results: SingleResult[] = [];
	let previousOutput = "";

	for (let i = 0; i < steps.length; i++) {
		if (signal?.aborted) throw new Error("Subagent was aborted");
		if (isBudgetExceeded(deadline)) {
			const step = steps[i];
			results.push({
				agent: step.agent,
				agentSource: "unknown",
				task: step.task,
				cwd: defaultCwd,
				exitCode: 1,
				messages: [],
				stderr: "Chain stopped: total budget exceeded.",
				usage: emptyUsage(),
				step: i + 1,
				stopReason: "error",
				errorMessage: "Chain stopped: total budget exceeded.",
				errorCode: "budget-exceeded",
				timedOut: false,
				durationMs: 0,
				attempts: 0,
			});
			break;
		}
		const step = steps[i];
		const taskWithContext = substitutePrevious(step.task, capPreviousOutput(previousOutput));

		const chainUpdate: OnUpdateCallback | undefined = onUpdate
			? (partial) => {
					const currentResult = partial.details?.results[0];
					if (currentResult) {
						const allResults = [...results, currentResult];
						onUpdate({ content: partial.content, details: makeDetails(allResults) } as any);
					}
				}
			: undefined;

		const { result, attempts } = await runWithRetry(
			() =>
				runSingleAgent(
					defaultCwd,
					dispatchDefaults,
					agents,
					step.agent,
					taskWithContext,
					step.cwd,
					i + 1,
					signal,
					chainUpdate,
					makeDetails,
					undefined,
					{ timeoutMs: step.timeoutMs ?? opts.fallbackTimeoutMs },
				),
			{ attempts: opts.retryAttempts, backoffMs: opts.retryBackoffMs, signal },
		);
		const withAttempts: SingleResult = { ...result, attempts };
		results.push(withAttempts);

		if (isFailedResult(withAttempts)) {
			if (onError === "abort") {
				const errorMsg = getResultOutput(withAttempts);
				return {
					results,
					text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
					isError: true,
				};
			}
			previousOutput = `(previous step failed: ${withAttempts.errorCode})`;
			continue;
		}
		previousOutput = getFinalOutput(withAttempts.messages);
	}
	const failed = results.filter((r) => isFailedResult(r)).length;
	const finalOutput = results.length > 0 ? getFinalOutput(results[results.length - 1].messages) || "(no output)" : "(no output)";
	return {
		results,
		text: truncateSingleOutput(finalOutput),
		isError: onError === "abort" ? failed > 0 : false,
	};
}
