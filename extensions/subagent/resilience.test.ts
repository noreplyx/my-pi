import { describe, expect, test } from "bun:test";
import {
	ALL_FAILURE_CODES,
	DEFAULT_RETRYABLE_CODES,
	MAX_RETRY_BACKOFF_MS,
	isBudgetExceeded,
	recommendedTotalTimeout,
	runWithRetry,
	totalDeadline,
} from "./resilience.ts";
import type { SubagentErrorCode } from "./utils.ts";

function createSequenceTask(sequence: SubagentErrorCode[]) {
	let calls = 0;
	const task = async () => {
		const index = Math.min(calls, sequence.length - 1);
		calls++;
		return { errorCode: sequence[index]! };
	};
	return { task, getCalls: () => calls };
}

describe("runWithRetry retry policy and failure code filtering", () => {
	test("succeeds on the first attempt without retrying", async () => {
		const { task, getCalls } = createSequenceTask(["ok"]);
		const { result, attempts } = await runWithRetry(task, {
			attempts: 2,
			backoffMs: 0,
			sleep: async () => {},
		});
		expect(result.errorCode).toBe("ok");
		expect(attempts).toBe(1);
		expect(getCalls()).toBe(1);
	});

	test("retries a non-zero exit code by default and succeeds on the second attempt", async () => {
		const { task, getCalls } = createSequenceTask(["non-zero", "ok"]);
		const { result, attempts } = await runWithRetry(task, {
			attempts: 2,
			backoffMs: 0,
			sleep: async () => {},
		});
		expect(result.errorCode).toBe("ok");
		expect(attempts).toBe(2);
		expect(getCalls()).toBe(2);
	});

	test("retries a process spawn failure by default and succeeds on the second attempt", async () => {
		const { task, getCalls } = createSequenceTask(["spawn-failed", "ok"]);
		const { result, attempts } = await runWithRetry(task, {
			attempts: 2,
			backoffMs: 0,
			sleep: async () => {},
		});
		expect(result.errorCode).toBe("ok");
		expect(attempts).toBe(2);
		expect(getCalls()).toBe(2);
	});

	test("does not retry a timed-out run by default", async () => {
		const { task, getCalls } = createSequenceTask(["timeout", "ok"]);
		const { result, attempts } = await runWithRetry(task, {
			attempts: 3,
			backoffMs: 0,
			sleep: async () => {},
		});
		expect(result.errorCode).toBe("timeout");
		expect(attempts).toBe(1);
		expect(getCalls()).toBe(1);
	});

	test("does not retry a setup configuration error by default", async () => {
		const { task, getCalls } = createSequenceTask(["setup-error", "ok"]);
		const { result, attempts } = await runWithRetry(task, {
			attempts: 3,
			backoffMs: 0,
			sleep: async () => {},
		});
		expect(result.errorCode).toBe("setup-error");
		expect(attempts).toBe(1);
		expect(getCalls()).toBe(1);
	});

	test("retries a timed-out run when timeout is explicitly listed in retryOn", async () => {
		const { task, getCalls } = createSequenceTask(["timeout", "ok"]);
		const { result, attempts } = await runWithRetry(task, {
			attempts: 2,
			backoffMs: 0,
			retryOn: ["timeout"],
			sleep: async () => {},
		});
		expect(result.errorCode).toBe("ok");
		expect(attempts).toBe(2);
		expect(getCalls()).toBe(2);
	});

	test("stops after exhausting all allowed attempts on repeated non-zero exits", async () => {
		const { task, getCalls } = createSequenceTask(["non-zero"]);
		const { result, attempts } = await runWithRetry(task, {
			attempts: 2,
			backoffMs: 0,
			sleep: async () => {},
		});
		expect(result.errorCode).toBe("non-zero");
		expect(attempts).toBe(2);
		expect(getCalls()).toBe(2);
	});

	test("skips retry when the failure code is not in the custom retryOn list", async () => {
		const { task, getCalls } = createSequenceTask(["non-zero", "ok"]);
		const { result, attempts } = await runWithRetry(task, {
			attempts: 3,
			backoffMs: 0,
			retryOn: ["timeout"],
			sleep: async () => {},
		});
		expect(result.errorCode).toBe("non-zero");
		expect(attempts).toBe(1);
		expect(getCalls()).toBe(1);
	});

	test("doubles backoff wait time exponentially between retryable failures", async () => {
		const delays: number[] = [];
		const { task, getCalls } = createSequenceTask(["non-zero"]);
		const { result, attempts } = await runWithRetry(task, {
			attempts: 3,
			backoffMs: 100,
			sleep: async (ms) => {
				delays.push(ms);
			},
		});
		expect(result.errorCode).toBe("non-zero");
		expect(attempts).toBe(3);
		expect(getCalls()).toBe(3);
		expect(delays).toEqual([100, 200]);
	});

	test("does not retry budget-exceeded or aborted error codes by default", async () => {
		expect(DEFAULT_RETRYABLE_CODES).toEqual(["spawn-failed", "non-zero"]);
		expect(ALL_FAILURE_CODES).toContain("budget-exceeded");
		expect(ALL_FAILURE_CODES).toContain("aborted");

		for (const terminalCode of ["budget-exceeded", "aborted"] as const) {
			const { task, getCalls } = createSequenceTask([terminalCode, "ok"]);
			const { result, attempts } = await runWithRetry(task, {
				attempts: 3,
				backoffMs: 0,
				sleep: async () => {},
			});
			expect(result.errorCode).toBe(terminalCode);
			expect(attempts).toBe(1);
			expect(getCalls()).toBe(1);
		}
	});

	test("throws immediately when the abort signal is already triggered before or during backoff", async () => {
		const preAborted = new AbortController();
		preAborted.abort();
		const { task: neverCalledTask, getCalls: getPreAbortedCalls } = createSequenceTask(["ok"]);
		await expect(
			runWithRetry(neverCalledTask, {
				attempts: 3,
				backoffMs: 0,
				signal: preAborted.signal,
			}),
		).rejects.toThrow("Subagent was aborted");
		expect(getPreAbortedCalls()).toBe(0);

		const midBackoff = new AbortController();
		const { task: abortDuringWaitTask, getCalls: getMidBackoffCalls } = createSequenceTask(["non-zero", "ok"]);
		await expect(
			runWithRetry(abortDuringWaitTask, {
				attempts: 3,
				backoffMs: 100,
				signal: midBackoff.signal,
				sleep: async () => {
					midBackoff.abort();
					await new Promise((r) => setTimeout(r, 50));
				},
			}),
		).rejects.toThrow("Subagent was aborted");
		expect(getMidBackoffCalls()).toBe(1);
	});

	test("caps exponential backoff at MAX_RETRY_BACKOFF_MS (30,000ms) and clamps attempts to [1, 5]", async () => {
		const delays: number[] = [];
		const { task: failingTask, getCalls: getFailingCalls } = createSequenceTask(["non-zero"]);
		const { attempts: maxClampedAttempts } = await runWithRetry(failingTask, {
			attempts: 99,
			backoffMs: 20_000,
			sleep: async (ms) => {
				delays.push(ms);
			},
		});
		expect(maxClampedAttempts).toBe(5);
		expect(getFailingCalls()).toBe(5);
		expect(delays).toEqual([20_000, MAX_RETRY_BACKOFF_MS, MAX_RETRY_BACKOFF_MS, MAX_RETRY_BACKOFF_MS]);

		const { task: singleAttemptTask, getCalls: getSingleCalls } = createSequenceTask(["non-zero", "ok"]);
		const { attempts: minClampedAttempts } = await runWithRetry(singleAttemptTask, {
			attempts: 0,
			backoffMs: 0,
			sleep: async () => {},
		});
		expect(minClampedAttempts).toBe(1);
		expect(getSingleCalls()).toBe(1);
	});
});

describe("total budget deadline", () => {
	test("unset budget never exceeds", () => {
		expect(isBudgetExceeded(undefined)).toBe(false);
		expect(totalDeadline(undefined)).toBeUndefined();
	});

	test("past deadline exceeds, future does not", () => {
		const past = Date.now() - 1000;
		const future = Date.now() + 60000;
		expect(isBudgetExceeded(past)).toBe(true);
		expect(isBudgetExceeded(future)).toBe(false);
	});

	test("invalid budgets yield no deadline", () => {
		expect(totalDeadline(0)).toBeUndefined();
		expect(totalDeadline(-5)).toBeUndefined();
		expect(totalDeadline(Number.NaN)).toBeUndefined();
	});

	test("recommended budgets: parallel/swarm take max+60s", () => {
		expect(recommendedTotalTimeout([1000, 2000, 3000], "parallel")).toBe(63000);
		expect(recommendedTotalTimeout([5000], "swarm")).toBe(65000);
	});
});
