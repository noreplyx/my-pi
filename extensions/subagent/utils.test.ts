import { describe, expect, test } from "bun:test";
import {
	CHILD_RPC_STATIC_FLAGS,
	MAX_SWARM_DEPTH,
	TIMEOUT_DEFAULT_MS,
	TIMEOUT_MAX_MS,
	agentUsesMcp,
	aggregateUsage,
	appendBounded,
	buildChildEnv,
	buildChildProcessArgs,
	clampTimeoutMs,
	emptyUsage,
	ensureSwarmTools,
	formatDuration,
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
	swarmProtocolSnippet,
	truncateToBudget,
	validateModelString,
	validateToolList,
} from "./utils.ts";

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

	test("passes through LC_* but not legacy PI_PERMISSIONS_FILE", () => {
		const env = buildChildEnv({ PI_PERMISSIONS_FILE: "/p.json", LC_TIME: "C" }, {});
		expect(env.PI_PERMISSIONS_FILE).toBeUndefined();
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
		expect(ensureSwarmTools(["read"])).toEqual(["read", "subagent", "write", "bash", "codemode"]);
		expect(ensureSwarmTools(["read", "subagent"])).toEqual(["read", "subagent", "write", "bash", "codemode"]);
		expect(ensureSwarmTools(undefined)).toEqual(["subagent", "read", "write", "bash", "codemode"]);
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

describe("clampTimeoutMs", () => {
	test("undefined → default", () => {
		expect(clampTimeoutMs(undefined).timeoutMs).toBe(TIMEOUT_DEFAULT_MS);
	});

	test("rejects non-positive / non-numeric", () => {
		expect(clampTimeoutMs(0).error).toBeDefined();
		expect(clampTimeoutMs(-5).error).toBeDefined();
		expect(clampTimeoutMs("nope").error).toBeDefined();
	});

	test("clamps over max", () => {
		const r = clampTimeoutMs(TIMEOUT_MAX_MS + 1000);
		expect(r.timeoutMs).toBe(TIMEOUT_MAX_MS);
		expect(r.clamped).toBe(true);
	});

	test("floors fractional values", () => {
		expect(clampTimeoutMs(1500.9).timeoutMs).toBe(1500);
	});
});

describe("formatDuration", () => {
	test("formats seconds, minutes, hours", () => {
		expect(formatDuration(1500)).toBe("1.5s");
		expect(formatDuration(252000)).toBe("4m12s");
		expect(formatDuration(3720000)).toContain("1h");
	});
});

describe("appendBounded multibyte", () => {
	test("never splits a code point and respects byte cap", () => {
		const emoji = "😀".repeat(100); // 4 bytes each in UTF-8
		const out = appendBounded("", emoji, 100);
		expect(out.truncated).toBe(true);
		expect(Buffer.byteLength(out.text, "utf8")).toBeLessThanOrEqual(100);
		expect(() => encodeURIComponent(out.text)).not.toThrow();
		expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(out.text)).toBe(false);
	});

	test("cjk bytes counted, not chars", () => {
		const s = "あ".repeat(50); // 3 bytes each
		const out = appendBounded("", s, 100);
		expect(Buffer.byteLength(out.text, "utf8")).toBeLessThanOrEqual(100);
		expect(out.text.length).toBeLessThan(50);
	});
});

describe("generateRunId crypto", () => {
	test("deterministic path still valid", () => {
		expect(isValidRunId(generateRunId(1710000000000, 0.5))).toBe(true);
	});

	test("crypto path valid format, deterministic path unique", () => {
		for (let i = 0; i < 200; i++) expect(isValidRunId(generateRunId())).toBe(true);
		const t = 1710000000000;
		expect(generateRunId(t, 0.1)).not.toBe(generateRunId(t, 0.9));
		const spot = new Set(Array.from({ length: 20 }, () => generateRunId()));
		expect(spot.size).toBe(20);
	});
});

describe("mapWithConcurrencyLimit abort", () => {
	test("stops queueing once aborted", async () => {
		const started: number[] = [];
		let abort = false;
		const out = await mapWithConcurrencyLimit([1, 2, 3, 4, 5], 1, async (n) => {
			started.push(n);
			if (n === 2) abort = true;
			await new Promise((r) => setTimeout(r, 5));
			return n;
		}, () => abort);
		expect(started.length).toBeLessThan(5);
		expect(out.length).toBe(5);
	});

	test("onSkipped fills drained slots (no holes)", async () => {
		let abort = false;
		const out = await mapWithConcurrencyLimit(
			[1, 2, 3, 4, 5],
			1,
			async (n) => {
				if (n === 2) abort = true;
				await new Promise((r) => setTimeout(r, 5));
				return `done-${n}`;
			},
			() => abort,
			(n) => `skipped-${n}`,
		);
		expect(out).toEqual(["done-1", "done-2", "skipped-3", "skipped-4", "skipped-5"]);
	});
});

describe("detecting whether an agent requires MCP servers (agentUsesMcp)", () => {
	test("returns false when tools, frontmatter permissions, and prompt body have no MCP references", () => {
		expect(
			agentUsesMcp(
				["read", "write", "bash", "codemode"],
				{
					name: "coder",
					permissions: {
						defaultAction: "deny",
						rules: [{ tool: "read", action: "allow" }],
					},
				},
				"You are a software engineer who edits TypeScript files.",
			),
		).toBe(false);
		expect(agentUsesMcp(undefined, {}, undefined)).toBe(false);
	});

	test("returns true when any declared tool starts with mcp__ (case-insensitive and whitespace-trimmed)", () => {
		expect(agentUsesMcp(["read", "mcp__ado__get_work_item"], {})).toBe(true);
		expect(agentUsesMcp(["  MCP__GitHub__search_issues  "], {})).toBe(true);
	});

	test("returns true when frontmatter permissions is a non-empty external file path string (fail-open)", () => {
		expect(agentUsesMcp(["read"], { permissions: "./permissions/custom.json" })).toBe(true);
		expect(agentUsesMcp(["read"], { permissions: "   " })).toBe(false);
	});

	test("returns true when frontmatter permission rules reference mcp__ in a string or array tool matcher", () => {
		expect(
			agentUsesMcp(["read"], {
				permissions: {
					rules: [{ tool: "re:^mcp__ado__", action: "allow" }],
				},
			}),
		).toBe(true);

		expect(
			agentUsesMcp(["read"], {
				permissions: {
					rules: [{ tool: ["read", "MCP__slack__post_message"], action: "allow" }],
				},
			}),
		).toBe(true);

		expect(
			agentUsesMcp(["read"], {
				permissions: {
					rules: [{ tool: ["read", "bash"], action: "allow" }],
				},
			}),
		).toBe(false);
	});

	test("returns true when the agent system prompt body mentions mcp__", () => {
		expect(agentUsesMcp(["read", "codemode"], {}, "Use mcp__ado tools inside codemode scripts.")).toBe(true);
		expect(agentUsesMcp(["read"], {}, "Query MCP__JIRA for ticket metadata.")).toBe(true);
	});

	test("ignores malformed or non-object entries in frontmatter permissions.rules without throwing", () => {
		expect(
			agentUsesMcp(["read"], {
				permissions: {
					rules: [null, undefined, 42, "invalid-rule", { tool: 123 }, { tool: [null, 99, "read"] }],
				},
			}),
		).toBe(false);
		expect(agentUsesMcp(["read"], { permissions: ["array-instead-of-object"] })).toBe(false);
		expect(agentUsesMcp(["read"], { permissions: { rules: "not-an-array" } })).toBe(false);
	});
});

describe("building child process command-line flags (buildChildProcessArgs)", () => {
	test("always includes --mode rpc, --no-session, and all static startup optimization flags", () => {
		const args = buildChildProcessArgs({
			inheritsDispatchConfig: false,
			usesMcp: true,
		});
		expect(args.slice(0, 3 + CHILD_RPC_STATIC_FLAGS.length)).toEqual([
			"--mode",
			"rpc",
			"--no-session",
			...CHILD_RPC_STATIC_FLAGS,
		]);
		expect(CHILD_RPC_STATIC_FLAGS).toEqual(["--no-themes", "--no-skills", "--no-prompt-templates", "--offline"]);
	});

	test("appends --no-mcp when usesMcp is false and omits --no-mcp when usesMcp is true", () => {
		const withoutMcp = buildChildProcessArgs({
			inheritsDispatchConfig: false,
			usesMcp: false,
		});
		const withMcp = buildChildProcessArgs({
			inheritsDispatchConfig: false,
			usesMcp: true,
		});
		expect(withoutMcp).toContain("--no-mcp");
		expect(withMcp).not.toContain("--no-mcp");
	});

	test("inherits --thinking only when inheritsDispatchConfig is true and thinkingLevel is provided", () => {
		const inherited = buildChildProcessArgs({
			inheritsDispatchConfig: true,
			thinkingLevel: "high",
			usesMcp: false,
		});
		const notInherited = buildChildProcessArgs({
			inheritsDispatchConfig: false,
			thinkingLevel: "high",
			usesMcp: false,
		});
		const missingLevel = buildChildProcessArgs({
			inheritsDispatchConfig: true,
			thinkingLevel: undefined,
			usesMcp: false,
		});
		expect(inherited).toContain("--thinking");
		expect(inherited[inherited.indexOf("--thinking") + 1]).toBe("high");
		expect(notInherited).not.toContain("--thinking");
		expect(missingLevel).not.toContain("--thinking");
	});

	test("passes --model when a model is resolved from either agent frontmatter or parent dispatch config", () => {
		const withModel = buildChildProcessArgs({
			model: "anthropic/claude-sonnet-4-5",
			inheritsDispatchConfig: false,
			usesMcp: false,
		});
		const withoutModel = buildChildProcessArgs({
			model: undefined,
			inheritsDispatchConfig: true,
			usesMcp: false,
		});
		expect(withModel).toContain("--model");
		expect(withModel[withModel.indexOf("--model") + 1]).toBe("anthropic/claude-sonnet-4-5");
		expect(withoutModel).not.toContain("--model");
	});

	test("joins effectiveTools with commas for --tools and omits --tools when empty or undefined", () => {
		const withTools = buildChildProcessArgs({
			effectiveTools: ["read", "edit", "bash"],
			inheritsDispatchConfig: false,
			usesMcp: false,
		});
		const emptyTools = buildChildProcessArgs({
			effectiveTools: [],
			inheritsDispatchConfig: false,
			usesMcp: false,
		});
		const undefinedTools = buildChildProcessArgs({
			effectiveTools: undefined,
			inheritsDispatchConfig: false,
			usesMcp: false,
		});
		expect(withTools).toContain("--tools");
		expect(withTools[withTools.indexOf("--tools") + 1]).toBe("read,edit,bash");
		expect(emptyTools).not.toContain("--tools");
		expect(undefinedTools).not.toContain("--tools");
	});

	test("appends --append-system-prompt when a temporary prompt file path is provided", () => {
		const promptPath = "/tmp/pi-subagent-123/prompt-coder.md";
		const withPrompt = buildChildProcessArgs({
			appendSystemPromptPath: promptPath,
			inheritsDispatchConfig: false,
			usesMcp: false,
		});
		const withoutPrompt = buildChildProcessArgs({
			appendSystemPromptPath: undefined,
			inheritsDispatchConfig: false,
			usesMcp: false,
		});
		expect(withPrompt.slice(-2)).toEqual(["--append-system-prompt", promptPath]);
		expect(withoutPrompt).not.toContain("--append-system-prompt");
	});
});
