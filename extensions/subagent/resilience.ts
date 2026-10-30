/**
 * Resilience helpers: retry with backoff + total-budget deadline checks.
 *
 * Pure and unit-testable (no pi runtime imports). The orchestrators
 * (parallel/swarm) use runWithRetry to get the agreed default:
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
/** Upper bound for retry backoff (30s): delay = min(backoffMs * 2^(attempt-1), MAX). */
export const MAX_RETRY_BACKOFF_MS = 30_000;
const ALL_FAILURE_CODES: SubagentErrorCode[] = ["timeout", "spawn-failed", "non-zero", "setup-error", "aborted", "budget-exceeded"];

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Abort-aware sleep: resolves after `ms` unless `signal` aborts first.
 * Pre-checks `aborted`, races sleep vs abort, throws the
 * "Subagent was aborted" sentinel on abort, removes the listener in
 * `finally`. Keeps the `sleep` override for tests. */
async function sleepAbortable(
	sleep: (ms: number) => Promise<void>,
	ms: number,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) throw new Error("Subagent was aborted");
	if (!signal) {
		await sleep(ms);
		return;
	}
	let onAbort!: () => void;
	const abortPromise = new Promise<never>((_, reject) => {
		onAbort = () => reject(new Error("Subagent was aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		await Promise.race([sleep(ms), abortPromise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

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
	const backoffMs = Math.min(MAX_RETRY_BACKOFF_MS, Math.max(0, opts?.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS));
	const sleep = opts?.sleep ?? defaultSleep;
	let last: T | null = null;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		if (opts?.signal?.aborted) throw new Error("Subagent was aborted");
		last = await fn(attempt);
		if (last.errorCode === "ok" || attempt === attempts) return { result: last, attempts: attempt };
		if (!isRetryable(last.errorCode, opts?.retryOn)) return { result: last, attempts: attempt };
		const delay = Math.min(backoffMs * 2 ** (attempt - 1), MAX_RETRY_BACKOFF_MS);
		if (delay > 0) await sleepAbortable(sleep, delay, opts?.signal);
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
export function recommendedTotalTimeout(perTaskMs: number[], mode: "parallel" | "swarm"): number {
	if (perTaskMs.length === 0) return 300000;
	return Math.max(...perTaskMs) + 60000;
}
