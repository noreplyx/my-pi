/**
 * Swarm orchestrator: blackboard fan-out + merger + fork-resume.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "./agents.ts";
import { createQuestionLock } from "./questions.ts";
import { isBudgetExceeded, runWithRetry, totalDeadline } from "./resilience.ts";
import { runSingleAgent } from "./single.ts";
import type { DispatchDefaults, OnUpdateCallback, ParentUI, SingleResult, SwarmCtx, SwarmInfo } from "./types.ts";
import type { ForwardedPermissionStore } from "./forwarded-permissions.ts";
import {
	MAX_CONCURRENCY,
	MAX_SWARM_TOTAL,
	RESULT_RUNNING,
	emptyUsage,
	getFinalOutput,
	isFailedResult,
	isValidWorkerId,
	mapWithConcurrencyLimit,
	truncateToBudget,
	truncateParallelOutput,
	truncateSingleOutput,
	buildMergerInput,
} from "./utils.ts";
import {
	appendOutboxValidated,
	appendTaskLedger,
	forkSwarmRun,
	isCancelled,
	readDoneFiles,
	updateManifestStatus,
	writeManifest,
} from "./swarm.ts";

/** Budget for merger `{previous}` substitution (packed done/*.md into the merger prompt). */
const MERGER_TASK_BUDGET = 12 * 1024;

/** Cap merger input before substituting it into the merger prompt. */
function capMergerInput(previousOutput: string): string {
	if (Buffer.byteLength(previousOutput, "utf8") <= MERGER_TASK_BUDGET) return previousOutput;
	return truncateToBudget(previousOutput, MERGER_TASK_BUDGET, "Previous worker output");
}

/**
 * Substitute the merger `{previous}` placeholder using a replacement
 * function, so `$`-patterns (`$&`, `$'`, `$$`, `$1`) in worker output
 * pass through literally instead of being interpreted.
 */
function substituteMergerInput(task: string, previousOutput: string): string {
	return task.replace(/\{previous\}/g, () => previousOutput);
}

export interface SwarmWorkerInput {
	id: string;
	agent: string;
	task: string;
	cwd?: string;
	timeoutMs?: number;
	allowQuestions?: boolean;
	questionTimeoutMs?: number;
}

export interface SwarmMergerInput {
	agent: string;
	task: string;
	cwd?: string;
	timeoutMs?: number;
	allowQuestions?: boolean;
	questionTimeoutMs?: number;
}

export interface SwarmOptions {
	fallbackTimeoutMs?: number;
	retryAttempts?: number;
	retryBackoffMs?: number;
	totalTimeoutMs?: number;
	onError?: "abort" | "continue";
	cleanup?: boolean;
	allowQuestions?: boolean;
	questionTimeoutMs?: number;
}

export interface SwarmDeps {
	defaultCwd: string;
	dispatchDefaults: DispatchDefaults;
	agents: AgentConfig[];
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	makeDetails: (results: SingleResult[], swarm?: SwarmInfo) => any;
	workerDepth: number;
	parentUI?: ParentUI;
	forwardedPermissions?: ForwardedPermissionStore;
}

function failedWorker(
	w: SwarmWorkerInput,
	defaultCwd: string,
	startedAt: number,
	message: string,
	code: SingleResult["errorCode"],
): SingleResult {
	return {
		agent: w.agent,
		agentSource: "unknown",
		task: w.task,
		cwd: defaultCwd,
		exitCode: 1,
		messages: [],
		stderr: message,
		usage: emptyUsage(),
		stopReason: code === "aborted" ? "aborted" : "error",
		errorMessage: message,
		errorCode: code,
		timedOut: false,
		durationMs: Date.now() - startedAt,
		attempts: 1,
	};
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

export function validateWorkers(workers: SwarmWorkerInput[], max = MAX_SWARM_TOTAL): string | null {
	if (workers.length > max) return `Too many swarm workers (${workers.length}). Max is ${max}.`;
	const seen = new Set<string>();
	for (const w of workers) {
		if (!isValidWorkerId(w.id)) return `Invalid worker id "${w.id}": use lowercase letters, digits, -, _.`;
		const key = w.id.toLowerCase();
		if (seen.has(key)) return `Duplicate worker id "${w.id}".`;
		seen.add(key);
	}
	return null;
}

export async function runSwarm(
	runId: string,
	swarmDir: string,
	goal: string,
	workers: SwarmWorkerInput[],
	merger: SwarmMergerInput | undefined,
	opts: SwarmOptions,
	deps: SwarmDeps,
): Promise<{ results: SingleResult[]; text: string; isError: boolean; swarmInfo: SwarmInfo; aborted: boolean }> {
	const { defaultCwd, dispatchDefaults, agents, signal, onUpdate, makeDetails, workerDepth, parentUI, forwardedPermissions } = deps;
	const deadline = totalDeadline(opts.totalTimeoutMs);
	const swarmInfo: SwarmInfo = { runId, swarmDir, depth: workerDepth };
	// Per-run FIFO question lock (isolated from single-mode global lock).
	// No default question timeout — opt-in via questionTimeoutMs only.
	const questionLock = createQuestionLock();

	await appendTaskLedger(
		swarmDir,
		JSON.stringify({ runId, goal, workers: workers.map((w) => ({ id: w.id, agent: w.agent, task: w.task.slice(0, 4000) })) }),
	);
	await writeManifest(swarmDir, {
		runId,
		goal,
		workers: workers.map((w) => ({ id: w.id, agent: w.agent })),
		status: "running",
		createdAt: new Date().toISOString(),
	});

	const allResults: SingleResult[] = workers.map((w) => ({
		agent: w.agent,
		agentSource: "unknown",
		task: w.task,
		cwd: defaultCwd,
		exitCode: RESULT_RUNNING,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		errorCode: "ok",
		timedOut: false,
		durationMs: 0,
	}));
	const emitSwarmUpdate = () => {
		if (onUpdate) {
			const running = allResults.filter((r) => r.exitCode === RESULT_RUNNING).length;
			const done = allResults.filter((r) => r.exitCode !== RESULT_RUNNING).length;
			onUpdate({
				content: [{ type: "text", text: `Swarm ${runId}: ${done}/${allResults.length} done, ${running} running...` }],
				details: makeDetails([...allResults], swarmInfo),
			} as any);
		}
	};
	let aborted = false;
	const onError = opts.onError ?? "continue";
	// Drain-only fail-fast: no new workers start after a failure with
	// onError=abort; in-flight workers run to completion (never killed).
	let failedFast = false;
	const checkCancelled = async (): Promise<boolean> => {
		if (signal?.aborted) return true;
		if (isBudgetExceeded(deadline)) return true;
		try {
			return await isCancelled(swarmDir);
		} catch {
			return false;
		}
	};

	const workerResults = await mapWithConcurrencyLimit(
		workers,
		MAX_CONCURRENCY,
		async (w, index) => {
			let result: SingleResult;
			const workerStartedAt = Date.now();
			try {
				if (await checkCancelled()) throw new Error("Subagent was aborted");
				const swarmCtx: SwarmCtx = { depth: workerDepth, swarmDir, runId, agentId: w.id };
				const { result: r, attempts } = await runWithRetry(
					() =>
						runSingleAgent(
							defaultCwd,
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
							(results: SingleResult[]) => makeDetails(results, swarmInfo),
							swarmCtx,
							{
								timeoutMs: w.timeoutMs ?? opts.fallbackTimeoutMs,
								allowQuestions: w.allowQuestions ?? opts.allowQuestions ?? true,
								questionTimeoutMs: w.questionTimeoutMs ?? opts.questionTimeoutMs,
								parentUI,
								forwardedPermissions,
								questionLock,
								labelPrefix: `[swarm ${runId}/${w.id}]`,
							},
						),
					{ attempts: opts.retryAttempts, backoffMs: opts.retryBackoffMs, signal },
				);
				result = { ...r, attempts };
			} catch (e) {
				if (signal?.aborted || (e as Error)?.message === "Subagent was aborted" || (await checkCancelled())) {
					aborted = true;
					result = failedWorker(w, defaultCwd, workerStartedAt, `Worker ${w.id} aborted.`, "aborted");
				} else {
					result = failedWorker(
						w,
						defaultCwd,
						workerStartedAt,
						`Worker ${w.id} failed before completion: ${(e as Error)?.message ?? e}`,
						"non-zero",
					);
				}
			}
			allResults[index] = result;
			if (onError === "abort" && isFailedResult(result) && result.errorCode !== "aborted" && result.errorCode !== "budget-exceeded")
				failedFast = true;
			try {
				await appendOutboxValidated(swarmDir, {
					from: w.id,
					to: "all",
					body: truncateParallelOutput(getResultOutput(result)).slice(0, 2000),
				});
			} catch {
				/* ignore */
			}
			emitSwarmUpdate();
			return result;
		},
		() => (signal?.aborted ?? false) || isBudgetExceeded(deadline) || (onError === "abort" && failedFast),
		(w, index) => {
			aborted = true;
			let skipped: SingleResult;
			if (signal?.aborted) {
				skipped = failedWorker(w, defaultCwd, Date.now(), `Worker ${w.id} skipped: swarm aborted before start.`, "aborted");
			} else if (isBudgetExceeded(deadline)) {
				skipped = failedWorker(w, defaultCwd, Date.now(), `Worker ${w.id} skipped: total budget exceeded.`, "budget-exceeded");
			} else {
				skipped = failedWorker(
					w,
					defaultCwd,
					Date.now(),
					`Worker ${w.id} skipped: onError=abort stopped queue after earlier failure.`,
					"aborted",
				);
			}
			allResults[index] = skipped;
			return skipped;
		},
	);

	const cancelled = await checkCancelled();
	if (aborted || cancelled || signal?.aborted || failedFast) {
		await updateManifestStatus(swarmDir, "aborted").catch(() => {});
		return {
			results: workerResults,
			text: `Swarm ${runId} aborted. Partial: ${workerResults.filter((r) => !isFailedResult(r)).length}/${workerResults.length} succeeded. Blackboard kept at ${swarmDir}.`,
			isError: true,
			swarmInfo,
			aborted: true,
		};
	}

	const successCount = workerResults.filter((r) => !isFailedResult(r)).length;
	const doneFiles = await readDoneFiles(swarmDir).catch(() => []);
	const sections =
		doneFiles.length > 0
			? doneFiles.map((d) => ({ id: d.id, agent: workers.find((w) => w.id === d.id)?.agent ?? "worker", body: d.body }))
			: workerResults.map((r, i) => ({ id: workers[i].id, agent: r.agent, body: getResultOutput(r) }));
	const packed = buildMergerInput(sections);
	const doneSection = packed.text;

	let mergerOutput = "";
	let mergerResult: SingleResult | null = null;
	if (merger && successCount > 0) {
		if (signal?.aborted) throw new Error("Subagent was aborted");
		const { result: r, attempts } = await runWithRetry(
			() =>
				runSingleAgent(
					defaultCwd,
					dispatchDefaults,
					agents,
					merger.agent,
					substituteMergerInput(merger.task, capMergerInput(doneSection)),
					merger.cwd,
					workerResults.length + 1,
					signal,
					onUpdate,
					(results: SingleResult[]) => makeDetails(results, swarmInfo),
					{ depth: workerDepth, swarmDir, runId, agentId: "merger" },
					{
						timeoutMs: merger.timeoutMs ?? opts.fallbackTimeoutMs,
						allowQuestions: merger.allowQuestions ?? opts.allowQuestions ?? true,
						questionTimeoutMs: merger.questionTimeoutMs ?? opts.questionTimeoutMs,
						parentUI,
						forwardedPermissions,
						questionLock,
						labelPrefix: `[swarm ${runId}/merger]`,
					},
				),
			{ attempts: opts.retryAttempts, backoffMs: opts.retryBackoffMs, signal },
		);
		mergerResult = { ...r, attempts };
		mergerOutput = getFinalOutput(mergerResult.messages) || "";
	}
	const allForDetails = mergerResult ? [...workerResults, mergerResult] : workerResults;
	const mergerFailed = mergerResult ? isFailedResult(mergerResult) : false;
	const fullyOk = successCount === workerResults.length && !mergerFailed && !signal?.aborted;
	if (opts.cleanup && fullyOk) {
		try {
			await fs.promises.rm(swarmDir, { recursive: true, force: true });
		} catch {
			/* best-effort: blackboard kept on cleanup failure */
		}
	} else {
		await updateManifestStatus(swarmDir, fullyOk ? "done" : "aborted").catch(() => {});
	}
	const header = `Swarm ${runId}: ${successCount}/${workerResults.length} workers succeeded. Blackboard: ${swarmDir}${opts.cleanup && fullyOk ? " (cleanup requested)" : ""}${packed.omitted > 0 ? ` (merger input: ${packed.included} included, ${packed.omitted} over budget)` : ""}`;
	const body = mergerResult
		? `${header}\n\n## Merger (${merger?.agent})\n\n${truncateSingleOutput(mergerOutput || "(no output)")}`
		: `${header}\n\n${doneSection.slice(0, 8000)}`;
	return { results: allForDetails, text: body, isError: successCount === 0, swarmInfo, aborted: false };
}

/**
 * Fork-resume: copy parent done/*.md into the fork so the merger sees the
 * full picture, then run only workers missing from the parent.
 */
export async function resumeMissingWorkers(
	cwd: string,
	parentRunId: string,
	merger: SwarmMergerInput | undefined,
	opts: SwarmOptions,
	deps: SwarmDeps,
): Promise<
	| { results: SingleResult[]; text: string; isError: boolean; swarmInfo: SwarmInfo; aborted: boolean }
	| { error: string }
> {
	const forked = await forkSwarmRun(cwd, parentRunId);
	if ("error" in forked) return { error: forked.error };
	const parentDir = `${cwd}/.swarm/${parentRunId}`;
	const parentDone = await readDoneFiles(parentDir).catch(() => []);
	const doneIds = new Set(parentDone.map((d) => d.id));
	const missing = forked.parent.workers.filter((w) => !doneIds.has(w.id));
	// Seed the fork with parent outputs so the merger input is complete.
	for (const d of parentDone) {
		try {
			await fs.promises.writeFile(path.join(forked.swarmDir, "done", `${d.id}.md`), d.body);
		} catch {
			/* ignore */
		}
	}
	if (missing.length === 0 && parentDone.length > 0) {
		// Nothing to run: synthesize a merger-only pass over parent outputs.
		const packed = buildMergerInput(
			parentDone.map((d) => ({ id: d.id, agent: forked.parent.workers.find((w) => w.id === d.id)?.agent ?? "worker", body: d.body })),
		);
		return {
			results: [],
			text: `Swarm ${forked.runId} (resumed from ${parentRunId}): all ${parentDone.length} workers already done, nothing to re-run. Merger input ready (${packed.included} sections).`,
			isError: false,
			swarmInfo: { runId: forked.runId, swarmDir: forked.swarmDir, depth: deps.workerDepth },
			aborted: false,
		};
	}
	// Rebuild full worker specs for the missing subset (need task text).
	// The manifest only stores id+agent, so task text comes from tasks.jsonl.
	let taskById = new Map<string, string>();
	try {
		const raw = await fs.promises.readFile(path.join(parentDir, "tasks.jsonl"), "utf-8");
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const v = JSON.parse(line) as { workers?: Array<{ id: string; task?: string }> };
				for (const w of v.workers ?? []) if (w.id && typeof w.task === "string") taskById.set(w.id, w.task);
			} catch {
				/* skip */
			}
		}
	} catch {
		/* ignore */
	}
	// Task text is recorded in tasks.jsonl for all runs created by runSwarm;
	// pre-manifest parent runs may lack it, in which case resume is impossible.
	const withoutTask = missing.filter((w) => !taskById.has(w.id));
	if (withoutTask.length > 0) {
		return { error: `Cannot resume: parent run ${parentRunId} did not record task text for: ${withoutTask.map((w) => w.id).join(", ")}` };
	}
	return runSwarm(
		forked.runId,
		forked.swarmDir,
		forked.parent.goal,
		missing.map((w) => ({ id: w.id, agent: w.agent, task: taskById.get(w.id) ?? "" })),
		merger,
		opts,
		deps,
	);
}
