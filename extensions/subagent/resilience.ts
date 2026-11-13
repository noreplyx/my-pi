/**
 * Resilience helpers: retry with backoff (no total budget — AbortSignal is the only cancellation source).
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
	/** Which error codes are retryable. Default: DEFAULT_RETRYABLE_CODES (["spawn-failed", "non-zero"]). Callers can pass explicit retryOn codes (e.g. ALL_FAILURE_CODES) if desired. */
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
export const DEFAULT_RETRYABLE_CODES: SubagentErrorCode[] = ["spawn-failed", "non-zero"];
export const ALL_FAILURE_CODES: SubagentErrorCode[] = ["timeout", "spawn-failed", "non-zero", "setup-error", "aborted", "budget-exceeded"];

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
	return (retryOn ?? DEFAULT_RETRYABLE_CODES).includes(code);
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

/**
 * @deprecated No-timeout policy: total budgets are ignored.
 * Always returns false; the AbortSignal is the only cancellation source.
 */
export function isBudgetExceeded(_deadline: number | undefined, _now = Date.now()): boolean {
	return false;
}

/**
 * @deprecated No-timeout policy: total budgets are ignored.
 * Always returns undefined (no deadline), whatever the input.
 */
export function totalDeadline(_totalTimeoutMs: number | undefined, _now = Date.now()): number | undefined {
	return undefined;
}

/**
 * @deprecated No-timeout policy: no budget is recommended or applied.
 * Always returns undefined; subagents wait indefinitely until abort.
 */
export function recommendedTotalTimeout(_perTaskMs: number[], _mode: "parallel" | "swarm"): number | undefined {
	return undefined;
}
