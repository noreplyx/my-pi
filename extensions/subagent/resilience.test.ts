import { describe, expect, test } from "bun:test";
import { isBudgetExceeded, recommendedTotalTimeout, runWithRetry, totalDeadline } from "./resilience.ts";

describe("runWithRetry (default: retry once on any failure)", () => {
	test("succeeds first try with attempts=1", async () => {
		let calls = 0;
		const { result, attempts } = await runWithRetry(
			async () => {
				calls++;
				return { errorCode: "ok" as const };
			},
			{ attempts: 2, backoffMs: 0, sleep: async () => {} },
		);
		expect(result.errorCode).toBe("ok");
		expect(attempts).toBe(1);
		expect(calls).toBe(1);
	});

	test("retries timeout then succeeds", async () => {
		let calls = 0;
		const { result, attempts } = await runWithRetry(
			async () => {
				calls++;
				return { errorCode: calls === 1 ? ("timeout" as const) : ("ok" as const) };
			},
			{ attempts: 2, backoffMs: 0, sleep: async () => {} },
		);
		expect(result.errorCode).toBe("ok");
		expect(attempts).toBe(2);
		expect(calls).toBe(2);
	});

	test("gives up after attempts exhausted (non-zero)", async () => {
		const { result, attempts } = await runWithRetry(
			async () => ({ errorCode: "non-zero" as const }),
			{ attempts: 2, backoffMs: 0, sleep: async () => {} },
		);
		expect(result.errorCode).toBe("non-zero");
		expect(attempts).toBe(2);
	});

	test("retryOn filter skips non-matching codes", async () => {
		let calls = 0;
		const { attempts } = await runWithRetry(
			async () => {
				calls++;
				return { errorCode: "non-zero" as const };
			},
			{ attempts: 3, backoffMs: 0, retryOn: ["timeout"], sleep: async () => {} },
		);
		expect(calls).toBe(1);
		expect(attempts).toBe(1);
	});

	test("backoff grows exponentially", async () => {
		const delays: number[] = [];
		await runWithRetry(async () => ({ errorCode: "timeout" as const }), {
			attempts: 3,
			backoffMs: 100,
			sleep: async (ms) => {
				delays.push(ms);
			},
		});
		expect(delays).toEqual([100, 200]);
	});

	test("aborted signal throws instead of retrying", async () => {
		const ctl = new AbortController();
		ctl.abort();
		await expect(
			runWithRetry(async () => ({ errorCode: "timeout" as const }), { attempts: 3, backoffMs: 0, signal: ctl.signal }),
		).rejects.toThrow("aborted");
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

	test("recommended budgets: chain sums, parallel/swarm take max+60s", () => {
		expect(recommendedTotalTimeout([1000, 2000, 3000], "chain")).toBe(6000);
		expect(recommendedTotalTimeout([1000, 2000, 3000], "parallel")).toBe(63000);
		expect(recommendedTotalTimeout([5000], "swarm")).toBe(65000);
	});
});
