import { describe, expect, test } from "bun:test";
import {
	MAX_SWARM_DEPTH,
	aggregateUsage,
	appendBounded,
	buildChildEnv,
	capPreviousOutput,
	emptyUsage,
	ensureSwarmTools,
	formatUsageStats,
	generateRunId,
	getFinalOutput,
	isFailedResult,
	isValidAgentName,
	isValidRunId,
	isValidWorkerId,
	makeSwarmMessage,
	mapWithConcurrencyLimit,
	nextSwarmDepth,
	normalizeAgentName,
	parseSwarmDepth,
	parseSwarmMessageLine,
	parseToolList,
	substitutePrevious,
	swarmProtocolSnippet,
	truncateToBudget,
	validateModelString,
	validateToolList,
} from "./utils.ts";

describe("substitutePrevious", () => {
	test("passes $-patterns through literally", () => {
		const out = substitutePrevious("a {previous} b", "costs $& and $' plus $$ and $1");
		expect(out).toBe("a costs $& and $' plus $$ and $1 b");
	});

	test("replaces all occurrences", () => {
		expect(substitutePrevious("{previous} + {previous}", "x")).toBe("x + x");
	});
});

describe("capPreviousOutput", () => {
	test("short output passes through", () => {
		expect(capPreviousOutput("hello")).toBe("hello");
	});

	test("long output is truncated with a marker", () => {
		const big = "y".repeat(100 * 1024);
		const capped = capPreviousOutput(big);
		expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(13 * 1024);
		expect(capped).toContain("truncated");
	});
});

describe("truncateToBudget", () => {
	test("short output passes through", () => {
		expect(truncateToBudget("hi", 100)).toBe("hi");
	});

	test("long output is capped with omission note", () => {
		const big = "z".repeat(10_000);
		const out = truncateToBudget(big, 1000);
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(1200);
		expect(out).toContain("omitted");
	});

	test("never splits surrogate pairs", () => {
		const emoji = "😀".repeat(1000); // 4 bytes each in UTF-8, surrogate pairs in UTF-16
		const out = truncateToBudget(emoji, 100);
		expect(() => encodeURIComponent(out)).not.toThrow();
		// No lone surrogates in the truncated prefix.
		const prefix = out.split("\n\n[")[0];
		expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(prefix)).toBe(false);
	});
});

describe("getFinalOutput", () => {
	test("joins all text parts of the last assistant message", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "first " }] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "a" },
					{ type: "toolCall", name: "read", arguments: {} },
					{ type: "text", text: "b" },
				],
			},
		] as any;
		expect(getFinalOutput(messages)).toBe("ab");
	});

	test("empty when no assistant text", () => {
		expect(getFinalOutput([{ role: "user", content: [] }] as any)).toBe("");
	});
});

describe("isFailedResult", () => {
	test("exit code, error, and aborted count as failure", () => {
		expect(isFailedResult({ exitCode: 1 })).toBe(true);
		expect(isFailedResult({ exitCode: 0, stopReason: "error" })).toBe(true);
		expect(isFailedResult({ exitCode: 0, stopReason: "aborted" })).toBe(true);
		expect(isFailedResult({ exitCode: 0, stopReason: "end" })).toBe(false);
		expect(isFailedResult({ exitCode: 0 })).toBe(false);
	});
});

describe("validateModelString", () => {
	test("accepts provider/id and plain ids", () => {
		expect(validateModelString("opencode-go/kimi-k3").model).toBe("opencode-go/kimi-k3");
		expect(validateModelString(undefined)).toEqual({});
	});

	test("rejects flags and weird characters", () => {
		expect(validateModelString("--append-system-prompt /tmp/x").error).toBeDefined();
		expect(validateModelString("-x").error).toBeDefined();
		expect(validateModelString("a;b").error).toBeDefined();
		expect(validateModelString(42).error).toBeDefined();
	});
});

describe("validateToolList / parseToolList", () => {
	test("accepts string and array spellings", () => {
		expect(validateToolList("read, bash").tools).toEqual(["read", "bash"]);
		expect(validateToolList(["read", "bash"]).tools).toEqual(["read", "bash"]);
	});

	test("drops flag-like entries", () => {
		const { tools, dropped } = validateToolList(["read", "--no-sandbox", "x,--foo"]);
		expect(tools).toEqual(["read"]);
		expect(dropped.length).toBeGreaterThan(0);
	});

	test("non-string/array tools value is invalid (fail closed)", () => {
		expect(parseToolList(42).invalid).toBe(true);
		expect(parseToolList({ a: 1 }).invalid).toBe(true);
		expect(parseToolList(undefined)).toEqual({});
	});
});

describe("agent names", () => {
	test("normalization is case/whitespace-insensitive", () => {
		expect(normalizeAgentName("  Reviewer ")).toBe("reviewer");
	});

	test("validation rejects odd names", () => {
		expect(isValidAgentName("reviewer")).toBe(true);
		expect(isValidAgentName("my-agent_2")).toBe(true);
		expect(isValidAgentName("Reviewer")).toBe(false);
		expect(isValidAgentName("-x")).toBe(false);
		expect(isValidAgentName("")).toBe(false);
		expect(isValidAgentName("a b")).toBe(false);
	});
});

describe("buildChildEnv", () => {
	test("strips secrets, keeps locale/path basics and PI_* extras", () => {
		const env = buildChildEnv(
			{
				PATH: "/bin",
				HOME: "/home/u",
				LANG: "en_US.UTF-8",
				LC_ALL: "C",
				ANTHROPIC_API_KEY: "sk-secret",
				GH_TOKEN: "gho-secret",
				AWS_SECRET_ACCESS_KEY: "aws-secret",
				MY_EVIL: "x",
			},
			{ PI_AGENT_NAME: "reviewer", PI_AGENT_FILE: "/a.md" },
		);
		expect(env.PATH).toBe("/bin");
		expect(env.HOME).toBe("/home/u");
		expect(env.LANG).toBe("en_US.UTF-8");
		expect(env.PI_AGENT_NAME).toBe("reviewer");
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.GH_TOKEN).toBeUndefined();
		expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect(env.MY_EVIL).toBeUndefined();
	});

	test("passes through PI_PERMISSIONS_FILE and LC_*", () => {
		const env = buildChildEnv({ PI_PERMISSIONS_FILE: "/p.json", LC_TIME: "C" }, {});
		expect(env.PI_PERMISSIONS_FILE).toBe("/p.json");
		expect(env.LC_TIME).toBe("C");
	});
});

describe("appendBounded", () => {
	test("accumulates under the cap, flags over it", () => {
		const a = appendBounded("hi", " there", 100);
		expect(a).toEqual({ text: "hi there", truncated: false });
		const b = appendBounded("x".repeat(90), "y".repeat(50), 100);
		expect(b.truncated).toBe(true);
		expect(Buffer.byteLength(b.text, "utf8")).toBeLessThanOrEqual(100);
	});

	test("refuses growth once capped", () => {
		const capped = appendBounded("x".repeat(100), "more", 100);
		expect(capped.truncated).toBe(true);
		expect(capped.text).toBe("x".repeat(100));
	});
});

describe("aggregateUsage", () => {
	test("sums counters and takes max context tokens", () => {
		const total = aggregateUsage([
			{ usage: { ...emptyUsage(), input: 10, contextTokens: 100, turns: 1 } },
			{ usage: { ...emptyUsage(), input: 5, contextTokens: 300, turns: 2, cost: 0.5 } },
		]);
		expect(total.input).toBe(15);
		expect(total.turns).toBe(3);
		expect(total.cost).toBeCloseTo(0.5);
		expect(total.contextTokens).toBe(300);
		const str = formatUsageStats(total, "m");
		expect(str).toContain("ctx:");
	});
});

describe("mapWithConcurrencyLimit", () => {
	test("preserves order under concurrency", async () => {
		const out = await mapWithConcurrencyLimit([3, 1, 2], 2, async (n) => {
			await new Promise((r) => setTimeout(r, n * 5));
			return n * 10;
		});
		expect(out).toEqual([30, 10, 20]);
	});

	test("empty input", async () => {
		expect(await mapWithConcurrencyLimit([], 4, async (x: number) => x)).toEqual([]);
	});
});

describe("swarm guards", () => {
	test("depth increments until cap, then rejects", () => {
		expect(nextSwarmDepth(0)).toEqual({ depth: 1 });
		expect(nextSwarmDepth(MAX_SWARM_DEPTH - 1)).toEqual({ depth: MAX_SWARM_DEPTH });
		expect((nextSwarmDepth(MAX_SWARM_DEPTH) as { error: string }).error).toContain("depth");
		expect((nextSwarmDepth(-1) as { error: string }).error).toBeDefined();
	});

	test("parseSwarmDepth defaults to 0 on garbage", () => {
		expect(parseSwarmDepth(undefined)).toBe(0);
		expect(parseSwarmDepth("2")).toBe(2);
		expect(parseSwarmDepth("nope")).toBe(0);
	});

	test("run/worker ids validate", () => {
		const id = generateRunId(1710000000000, 0.5);
		expect(isValidRunId(id)).toBe(true);
		expect(isValidRunId("bad")).toBe(false);
		expect(isValidWorkerId("explorer-1")).toBe(true);
		expect(isValidWorkerId("Bad Name")).toBe(false);
	});

	test("swarm tools merge without dupes", () => {
		expect(ensureSwarmTools(["read"])).toEqual(["read", "subagent", "write", "bash"]);
		expect(ensureSwarmTools(undefined)).toEqual(["subagent", "read", "write", "bash"]);
	});

	test("swarm message round-trips, bad lines null", () => {
		const line = makeSwarmMessage("a", "b", "hi $&");
		expect(parseSwarmMessageLine(line)?.body).toBe("hi $&");
		expect(parseSwarmMessageLine("")).toBeNull();
		expect(parseSwarmMessageLine("{bad")).toBeNull();
	});

	test("protocol snippet mentions blackboard + depth", () => {
		const s = swarmProtocolSnippet("/repo/.swarm/r1", "w1", "r1", 1);
		expect(s).toContain(".swarm");
		expect(s).toContain("w1");
		expect(s).toContain(String(MAX_SWARM_DEPTH));
	});
});
