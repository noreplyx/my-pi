/**
 * Pre-approval format validation for the subagent tool.
 *
 * Pure and dependency-free (imports only utils.ts) so it stays unit-testable
 * with plain `bun test` outside the pi runtime.
 *
 * Purpose: catch malformed payloads (wrong mode shape, unknown agents, bad
 * worker ids, bad timeouts, …) BEFORE the project-local agent trust-approval
 * dialog in index.ts, so invalid calls fail fast without prompting the user.
 *
 * Error strings intentionally mirror the messages the per-mode dispatch paths
 * already produce, so the only behavior change is ordering (no prompt first).
 */
import {
	MAX_PARALLEL_TASKS,
	MAX_SWARM_TOTAL,
	SWARM_ENV_DEPTH,
	clampTimeoutMs,
	isValidWorkerId,
	nextSwarmDepth,
	parseSwarmDepth,
} from "./utils.ts";

export type SubagentMode = "single" | "parallel" | "swarm";

export interface FormatTaskItem {
	agent?: unknown;
	task?: unknown;
	timeoutMs?: unknown;
}

export interface FormatSwarmWorker extends FormatTaskItem {
	id?: unknown;
}

export interface SubagentFormatParams {
	agent?: unknown;
	task?: unknown;
	tasks?: unknown;
	swarm?: unknown;
	timeoutMs?: unknown;
	onError?: unknown;
}

export interface ValidateOptions {
	/** Pre-rendered agent list for error messages (index.ts builds this via formatAgentList). */
	availableText?: string;
	/** Swarm parent depth; defaults to parsing process.env[SWARM_ENV_DEPTH]. */
	parentDepth?: number;
}

export interface FormatCheck {
	mode: SubagentMode;
	/** Present when the payload is malformed. */
	error?: string;
	/** True for errors the dispatch path reports with isError (timeout). */
	isError?: boolean;
}

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.trim().length > 0;
}

function findUnknownAgent(items: Array<{ agent?: unknown }>, agents: Array<{ name: string }>): string | null {
	const known = new Set(agents.map((a) => a.name.toLowerCase()));
	for (const item of items) {
		if (typeof item.agent === "string" && !known.has(item.agent.toLowerCase())) return item.agent;
	}
	return null;
}

function checkTimeout(raw: unknown): string | null {
	const check = clampTimeoutMs(raw as number | undefined);
	return check.error ?? null;
}

/**
 * Validate a subagent tool payload. Always returns a best-guess `mode` (same
 * fallback index.ts uses) so callers can build details for early returns.
 */
export function validateSubagentFormat(
	params: SubagentFormatParams,
	agents: Array<{ name: string }>,
	opts?: ValidateOptions,
): FormatCheck {
	const availableText = opts?.availableText ?? (agents.map((a) => a.name).join(", ") || "none");

	const tasks = Array.isArray(params.tasks) ? (params.tasks as FormatTaskItem[]) : undefined;
	if (params.swarm !== undefined && (typeof params.swarm !== "object" || params.swarm === null || Array.isArray(params.swarm))) {
		return { mode: "single", error: `Invalid parameters. "swarm" must be an object with {goal, workers}.` };
	}
	const swarm = params.swarm !== null && typeof params.swarm === "object" && !Array.isArray(params.swarm)
		? (params.swarm as {
				goal?: unknown;
				workers?: unknown;
				merger?: unknown;
			})
		: undefined;
	const workers = swarm && Array.isArray(swarm.workers) ? (swarm.workers as FormatSwarmWorker[]) : undefined;

	const hasTasks = (tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const hasSwarm = (workers?.length ?? 0) > 0;
	const mode: SubagentMode = hasTasks ? "parallel" : hasSwarm ? "swarm" : "single";
	const fail = (error: string, isError?: boolean): FormatCheck => ({ mode, error, ...(isError ? { isError: true } : {}) });

	// Non-array mode fields are malformed (dispatch indexes into them).
	if (params.tasks !== undefined && !Array.isArray(params.tasks)) {
		return fail(`Invalid parameters. "tasks" must be an array of {agent, task}.`);
	}
	if (swarm && swarm.workers !== undefined && !Array.isArray(swarm.workers)) {
		return fail(`Invalid parameters. "swarm.workers" must be an array of {id, agent, task}.`);
	}

	// Partial single mode (agent xor task) never matched a mode before and
	// fell through to a generic error — name it explicitly.
	if (!hasSingle && (params.agent || params.task)) {
		return fail(`Invalid parameters. Single mode requires both "agent" and "task". Available agents: ${availableText}`);
	}

	const modeCount = Number(hasTasks) + Number(hasSingle) + Number(hasSwarm);
	if (modeCount !== 1) {
		return fail(`Invalid parameters. Provide exactly one mode. Available agents: ${availableText}`);
	}

	if (params.onError !== undefined && params.onError !== "abort" && params.onError !== "continue") {
		return fail(`Invalid onError: expected "abort" or "continue".`);
	}

	const topTimeoutErr = checkTimeout(params.timeoutMs);
	if (topTimeoutErr) return fail(`Invalid timeoutMs: ${topTimeoutErr}.`, true);

	const checkItems = (
		items: FormatTaskItem[],
		label: (i: number) => string,
	): string | null => {
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (!isNonEmptyString(item.task)) return `Invalid task for ${label(i)}: task must be a non-empty string.`;
			const timeoutErr = checkTimeout(item.timeoutMs ?? params.timeoutMs);
			if (timeoutErr) return `Invalid timeoutMs for ${label(i)}: ${timeoutErr}.`;
		}
		return null;
	};

	const unknownErr = (names: Array<{ agent?: unknown }>, where: string): string | null => {
		const unknown = findUnknownAgent(names, agents);
		return unknown !== null ? `Unknown agent: "${unknown}"${where}. Available agents: ${availableText}.` : null;
	};

	if (hasSingle) {
		const u = unknownErr([{ agent: params.agent }], "");
		if (u) return fail(u);
		if (!isNonEmptyString(params.task)) return fail(`Invalid task for agent "${params.agent}": task must be a non-empty string.`);
		return { mode };
	}

	if (hasTasks) {
		const list = tasks as FormatTaskItem[];
		if (list.length > MAX_PARALLEL_TASKS) {
			return fail(`Too many parallel tasks (${list.length}). Max is ${MAX_PARALLEL_TASKS}.`);
		}
		const u = unknownErr(list, " in parallel tasks");
		if (u) return fail(u);
		const bad = checkItems(list, (i) => `parallel task ${i + 1} ("${list[i].agent}")`);
		if (bad) return fail(bad, bad.startsWith("Invalid timeoutMs"));
		return { mode };
	}

	// Swarm mode.
	const spec = swarm as { goal?: unknown; workers?: unknown; merger?: unknown };
	const workerList = workers as FormatSwarmWorker[];
	if (workerList.length > MAX_SWARM_TOTAL) {
		return fail(`Too many swarm workers (${workerList.length}). Max is ${MAX_SWARM_TOTAL}.`);
	}
	const seen = new Set<string>();
	for (const w of workerList) {
		if (typeof w.id !== "string" || !isValidWorkerId(w.id)) {
			return fail(`Invalid worker id "${w.id}": use lowercase letters, digits, -, _.`);
		}
		const key = w.id.toLowerCase();
		if (seen.has(key)) return fail(`Duplicate worker id "${w.id}".`);
		seen.add(key);
	}
	if (!isNonEmptyString(spec.goal)) return fail(`Invalid swarm goal: goal must be a non-empty string.`);
	const u = unknownErr(workerList, " in swarm workers");
	if (u) return fail(u);
	const bad = checkItems(workerList, (i) => `swarm worker "${workerList[i].id}"`);
	if (bad) return fail(bad, bad.startsWith("Invalid timeoutMs"));
	const merger =
		spec.merger !== null && typeof spec.merger === "object" && !Array.isArray(spec.merger)
			? (spec.merger as FormatTaskItem)
			: undefined;
	if (spec.merger !== undefined && merger === undefined) {
		return fail(`Invalid swarm merger: merger must be an object with "agent" and "task".`);
	}
	if (merger) {
		if (!isNonEmptyString(merger.agent) || !isNonEmptyString(merger.task)) {
			return fail(`Invalid swarm merger: merger requires both "agent" and "task".`);
		}
		const mu = unknownErr([merger], " in swarm merger");
		if (mu) return fail(mu);
		const mTimeoutErr = checkTimeout(merger.timeoutMs ?? params.timeoutMs);
		if (mTimeoutErr) return fail(`Invalid timeoutMs for swarm merger ("${merger.agent}"): ${mTimeoutErr}.`, true);
	}
	const parentDepth = opts?.parentDepth ?? parseSwarmDepth((process.env as Record<string, string | undefined>)[SWARM_ENV_DEPTH]);
	const depthCheck = nextSwarmDepth(parentDepth);
	if ("error" in depthCheck) return fail(`Swarm rejected: ${depthCheck.error}.`);
	return { mode };
}
