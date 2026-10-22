/**
 * Resilience helpers: retry with backoff + total-budget deadline checks.
 *
 * Pure and unit-testable (no pi runtime imports). The orchestrators
 * (parallel/chain/swarm) use runWithRetry to get the agreed default:
 * retry once on any failure.
 */
import type { SubagentErrorCode } from "./utils.ts";

export interface RetryOptions {
	/** Max attempts total (1 = no retry). Default 2 (retry once). */
	attempts?: number;
	/** Base backoff between attempts in ms. Default 1000, doubled per retry. */
	backoffMs?: number;
	/** Which error codes are retryable. Default: all failure codes. */
	retryOn?: SubagentErrorCode[];
	/** AbortSignal to stop waiting between retries. */
	signal?: AbortSignal;
	/** Sleep override for tests. */
	sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY_ATTEMPTS = 2;
export const DEFAULT_RETRY_BACKOFF_MS = 1000;
const ALL_FAILURE_CODES: SubagentErrorCode[] = ["timeout", "spawn-failed", "non-zero", "setup-error", "aborted", "budget-exceeded"];

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryable(code: SubagentErrorCode, retryOn: SubagentErrorCode[] | undefined): boolean {
	if (code === "ok") return false;
	return (retryOn ?? ALL_FAILURE_CODES).includes(code);
}

export interface RetryableResult {
	errorCode: SubagentErrorCode;
}

/**
 * Run fn up to `attempts` times until it returns errorCode "ok".
 * Aborts are never retried (they throw instead of returning).
 * Returns the last result + attempts count.
 */
export async function runWithRetry<T extends RetryableResult>(
	fn: (attempt: number) => Promise<T>,
	opts?: RetryOptions,
): Promise<{ result: T; attempts: number }> {
	const attempts = Math.max(1, Math.min(5, Math.floor(opts?.attempts ?? DEFAULT_RETRY_ATTEMPTS)));
	const backoffMs = Math.max(0, opts?.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS);
	const sleep = opts?.sleep ?? defaultSleep;
	let last: T | null = null;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		if (opts?.signal?.aborted) throw new Error("Subagent was aborted");
		last = await fn(attempt);
		if (last.errorCode === "ok" || attempt === attempts) return { result: last, attempts: attempt };
		if (!isRetryable(last.errorCode, opts?.retryOn)) return { result: last, attempts: attempt };
		const delay = backoffMs * 2 ** (attempt - 1);
		if (delay > 0) await sleep(delay);
	}
	return { result: last as T, attempts };
}

/** True when the total budget deadline has passed. Unset budget = no deadline. */
export function isBudgetExceeded(deadline: number | undefined, now = Date.now()): boolean {
	return deadline !== undefined && now >= deadline;
}

/** Compute a deadline timestamp from a total budget, or undefined when unset. */
export function totalDeadline(totalTimeoutMs: number | undefined, now = Date.now()): number | undefined {
	if (totalTimeoutMs === undefined) return undefined;
	if (!Number.isFinite(totalTimeoutMs) || totalTimeoutMs <= 0) return undefined;
	return now + Math.floor(totalTimeoutMs);
}

/** Recommended total budget when the caller did not set one (docs only, not applied). */
export function recommendedTotalTimeout(perTaskMs: number[], mode: "chain" | "parallel" | "swarm"): number {
	if (perTaskMs.length === 0) return 300000;
	if (mode === "chain") return perTaskMs.reduce((a, b) => a + b, 0);
	return Math.max(...perTaskMs) + 60000;
}
