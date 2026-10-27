import { describe, expect, test } from "bun:test";
import { MAX_PARALLEL_TASKS, MAX_SWARM_DEPTH, MAX_SWARM_TOTAL } from "./utils.ts";
import { validateSubagentFormat } from "./validate.ts";

const agents = [{ name: "coder" }, { name: "reviewer" }];
const avail = { availableText: "coder (user): d; reviewer (user): d" };

describe("validateSubagentFormat", () => {
	test("valid single passes", () => {
		expect(validateSubagentFormat({ agent: "coder", task: "do it" }, agents, avail)).toEqual({ mode: "single" });
	});

	test("no mode → error, no approval-worthy prompt", () => {
		const r = validateSubagentFormat({}, agents, avail);
		expect(r.mode).toBe("single");
		expect(r.error).toContain("exactly one mode");
	});

	test("two modes → error", () => {
		const r = validateSubagentFormat({ agent: "coder", task: "x", tasks: [{ agent: "coder", task: "y" }] }, agents, avail);
		expect(r.error).toContain("exactly one mode");
	});

	test("partial single (agent without task) → explicit error", () => {
		const r = validateSubagentFormat({ agent: "coder" }, agents, avail);
		expect(r.error).toContain('requires both "agent" and "task"');
	});

	test("non-array tasks/chain, non-object swarm → errors", () => {
		expect(validateSubagentFormat({ tasks: "x" } as any, agents, avail).error).toContain('"tasks" must be an array');
		expect(validateSubagentFormat({ chain: "x" } as any, agents, avail).error).toContain('"chain" must be an array');
		expect(validateSubagentFormat({ swarm: "x" } as any, agents, avail).error).toContain('"swarm" must be an object');
		expect(
			validateSubagentFormat({ swarm: { goal: "g", workers: "x" } } as any, agents, avail).error,
		).toContain('"swarm.workers" must be an array');
	});

	test("unknown agent reported before any approval", () => {
		const r = validateSubagentFormat({ agent: "nope", task: "x" }, agents, avail);
		expect(r.error).toBe('Unknown agent: "nope". Available agents: coder (user): d; reviewer (user): d.');
	});

	test("unknown agent lookup is case-insensitive", () => {
		expect(validateSubagentFormat({ agent: "Coder", task: "x" }, agents, avail).error).toBeUndefined();
	});

	test("empty task → error", () => {
		const r = validateSubagentFormat({ agent: "coder", task: "  " }, agents, avail);
		expect(r.error).toContain("must be a non-empty string");
	});

	test("too many parallel tasks → error matching dispatch message", () => {
		const many = Array.from({ length: MAX_PARALLEL_TASKS + 1 }, (_, i) => ({ agent: "coder", task: `t${i}` }));
		const r = validateSubagentFormat({ tasks: many }, agents, avail);
		expect(r.error).toBe(`Too many parallel tasks (${many.length}). Max is ${MAX_PARALLEL_TASKS}.`);
		expect(r.mode).toBe("parallel");
	});

	test("parallel unknown agent names task index", () => {
		const r = validateSubagentFormat(
			{ tasks: [{ agent: "coder", task: "a" }, { agent: "ghost", task: "b" }] },
			agents,
			avail,
		);
		expect(r.error).toContain('Unknown agent: "ghost" in parallel tasks');
	});

	test("chain unknown agent + empty step task", () => {
		const badAgent = validateSubagentFormat({ chain: [{ agent: "ghost", task: "a" }] }, agents, avail);
		expect(badAgent.error).toContain('Unknown agent: "ghost" in chain steps');
		const emptyTask = validateSubagentFormat({ chain: [{ agent: "coder", task: "" }] }, agents, avail);
		expect(emptyTask.error).toContain("chain step 1");
	});

	test("invalid timeoutMs flagged with isError", () => {
		const r = validateSubagentFormat({ agent: "coder", task: "x", timeoutMs: 0 }, agents, avail);
		expect(r.error).toContain("Invalid timeoutMs");
		expect(r.isError).toBe(true);
		const perTask = validateSubagentFormat(
			{ tasks: [{ agent: "coder", task: "a", timeoutMs: -5 }] },
			agents,
			avail,
		);
		expect(perTask.error).toContain("Invalid timeoutMs");
		expect(perTask.isError).toBe(true);
	});

	test("swarm: bad id, duplicate id, too many, empty goal", () => {
		const w = (id: string) => ({ id, agent: "coder", task: "t" });
		expect(
			validateSubagentFormat({ swarm: { goal: "g", workers: [w("Bad")] } }, agents, avail).error,
		).toContain('Invalid worker id "Bad"');
		expect(
			validateSubagentFormat({ swarm: { goal: "g", workers: [w("a"), w("a")] } }, agents, avail).error,
		).toContain('Duplicate worker id "a"');
		const many = Array.from({ length: MAX_SWARM_TOTAL + 1 }, (_, i) => w(`w${i}`));
		expect(validateSubagentFormat({ swarm: { goal: "g", workers: many } }, agents, avail).error).toContain(
			`Too many swarm workers (${many.length})`,
		);
		expect(
			validateSubagentFormat({ swarm: { goal: "  ", workers: [w("a")] } }, agents, avail).error,
		).toContain("goal must be a non-empty string");
	});

	test("swarm merger validated", () => {
		const w = { id: "a", agent: "coder", task: "t" };
		const noTask = validateSubagentFormat({ swarm: { goal: "g", workers: [w], merger: { agent: "coder" } } }, agents, avail);
		expect(noTask.error).toContain('merger requires both "agent" and "task"');
		const badAgent = validateSubagentFormat(
			{ swarm: { goal: "g", workers: [w], merger: { agent: "ghost", task: "m" } } },
			agents,
			avail,
		);
		expect(badAgent.error).toContain('Unknown agent: "ghost" in swarm merger');
	});

	test("swarm depth cap enforced", () => {
		const w = { id: "a", agent: "coder", task: "t" };
		const r = validateSubagentFormat({ swarm: { goal: "g", workers: [w] } }, agents, { ...avail, parentDepth: MAX_SWARM_DEPTH });
		expect(r.error).toContain("Swarm rejected");
		const ok = validateSubagentFormat({ swarm: { goal: "g", workers: [w] } }, agents, { ...avail, parentDepth: 0 });
		expect(ok.error).toBeUndefined();
		expect(ok.mode).toBe("swarm");
	});

	test("invalid onError → error", () => {
		const r = validateSubagentFormat({ agent: "coder", task: "x", onError: "skip" }, agents, avail);
		expect(r.error).toContain('Invalid onError');
	});

	test("valid parallel / chain / swarm pass", () => {
		expect(
			validateSubagentFormat({ tasks: [{ agent: "coder", task: "a" }, { agent: "reviewer", task: "b" }] }, agents, avail),
		).toEqual({ mode: "parallel" });
		expect(validateSubagentFormat({ chain: [{ agent: "coder", task: "a" }] }, agents, avail)).toEqual({ mode: "chain" });
		expect(
			validateSubagentFormat(
				{ swarm: { goal: "g", workers: [{ id: "a", agent: "coder", task: "t" }], merger: { agent: "reviewer", task: "m {previous}" } } },
				agents,
				avail,
			),
		).toEqual({ mode: "swarm" });
	});
});
