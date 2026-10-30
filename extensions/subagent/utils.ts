/**
 * Pure, dependency-free helpers for the subagent extension.
 *
 * This module intentionally imports nothing (not even node builtins beyond
 * Buffer, which bun/node always provide) so its logic is unit-testable with
 * plain `bun test` outside the pi runtime, where `@earendil-works/*`
 * packages do not resolve.
 */

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
/** Hierarchical swarm caps (user-confirmed defaults). */
export const MAX_SWARM_DEPTH = 3;
export const MAX_SWARM_TOTAL = 8;
/** Default per-subagent wall-clock budget (5 min); hard ceiling (30 min). */
export const TIMEOUT_DEFAULT_MS = 5 * 60 * 1000;
export const TIMEOUT_MAX_MS = 30 * 60 * 1000;
/** Grace between SIGTERM and SIGKILL for child process groups. */
export const KILL_GRACE_MS = 5000;
/** Max un-newlined stdout retained before oldest bytes are dropped (giant-line guard). */
export const STDOUT_LINE_CAP = 256 * 1024;
/** Swarm GC defaults: delete runs older than 7d, keep newest 10. */
export const SWARM_GC_DEFAULT_DAYS = 7;
export const SWARM_GC_KEEP_LAST = 10;
/** Blackboard dir name inside repo cwd: <cwd>/.swarm/<runId>/ */
export const SWARM_DIR_NAME = ".swarm";
/** Env keys threaded into child `pi` processes for swarm identity. */
export const SWARM_ENV_DIR = "PI_SWARM_DIR";
export const SWARM_ENV_RUN = "PI_SWARM_RUN";
export const SWARM_ENV_ID = "PI_SWARM_ID";
export const SWARM_ENV_DEPTH = "PI_SUBAGENT_DEPTH";
/** Tools a swarm worker needs for blackboard + recursion. Merged, never removed. */
export const SWARM_REQUIRED_TOOLS = ["subagent", "read", "write", "bash"];
/** Run IDs are fs-safe timestamps: swarm-YYYYMMDD-HHMMSS-xxxx, forks append -rN */
export const SWARM_RUN_ID_RE = /^swarm-\d{8}-\d{6}-[a-z0-9]{4}(?:-r\d+)?$/;
export const SWARM_WORKER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Cap for per-task text surfaced in parallel summaries. */
export const PER_TASK_OUTPUT_CAP = 50 * 1024;
/** Cap for single final output surfaced in the tool result. */
export const SINGLE_OUTPUT_CAP = 100 * 1024;
/** Cap for raw child stdout accumulation (DoS guard). */
export const STDOUT_CAP = 2 * 1024 * 1024;
/** Cap for raw child stderr accumulation (DoS guard). */
export const STDERR_CAP = 128 * 1024;
/** Cap for messages retained per subagent result. */
export const MAX_MESSAGES = 500;
/** Max agent markdown file size read from disk (DoS guard). */
export const MAX_AGENT_FILE_BYTES = 64 * 1024;
/** Max system-prompt body kept per agent (DoS guard). */
export const MAX_SYSTEM_PROMPT_CHARS = 32 * 1024;
/** Max description length kept per agent. */
export const MAX_DESCRIPTION_CHARS = 2000;

/** Sentinel for "task still running" in parallel placeholder results. */
export const RESULT_RUNNING = -1;

/** Machine-readable cause for a subagent result. */
export type SubagentErrorCode =
	| "ok"
	| "spawn-failed"
	| "timeout"
	| "aborted"
	| "non-zero"
	| "setup-error"
	| "budget-exceeded";

/** Budget for packing merger input (done/*.md + outbox fallback). */
export const MERGER_INPUT_BUDGET = 24 * 1024;

/** Clamp a caller-supplied timeoutMs to [1, TIMEOUT_MAX_MS]; undefined → default. */
export function clampTimeoutMs(raw: unknown): { timeoutMs: number; clamped: boolean; error?: string } {
	if (raw === undefined) return { timeoutMs: TIMEOUT_DEFAULT_MS, clamped: false };
	const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
	if (typeof n !== "number" || !Number.isFinite(n)) return { timeoutMs: TIMEOUT_DEFAULT_MS, clamped: false, error: "timeoutMs must be a finite number of milliseconds" };
	if (n <= 0) return { timeoutMs: TIMEOUT_DEFAULT_MS, clamped: false, error: "timeoutMs must be positive" };
	if (n > TIMEOUT_MAX_MS) return { timeoutMs: TIMEOUT_MAX_MS, clamped: true };
	return { timeoutMs: Math.floor(n), clamped: false };
}

/** Humanize durationMs for TUI (12.3s, 4m12s, 1h02m). */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0s";
	const s = Math.round(ms / 100) / 10;
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = Math.round(s % 60);
	if (m < 60) return `${m}m${String(rem).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Agent names are normalized to lowercase keys; valid names match this. */
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** `--model` values must look like `provider/id` or a plain id, never flags. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
/** Tool names passed to `--tools` must be bare identifiers. */
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

/**
 * Pack worker outputs into a merger prompt section within a byte budget.
 * Deterministic order (sorted by id); each section is capped so one giant
 * worker cannot evict the rest. Returns the packed text + omitted count.
 */
export function buildMergerInput(
	sections: Array<{ id: string; agent: string; body: string }>,
	budgetBytes = MERGER_INPUT_BUDGET,
): { text: string; included: number; omitted: number } {
	const sorted = [...sections].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	if (sorted.length === 0) return { text: "(no worker outputs)", included: 0, omitted: 0 };
	const perSectionCap = Math.max(1024, Math.floor(budgetBytes / Math.max(1, sorted.length)));
	const parts: string[] = [];
	let omitted = 0;
	for (const s of sorted) {
		const header = `#### ${s.id} (${s.agent})`;
		const capped = truncateToBudget(s.body || "(no output)", perSectionCap, `Output ${s.id}`);
		const section = `${header}\n\n${capped}`;
		const currentBytes = Buffer.byteLength(parts.join("\n\n---\n\n"), "utf8");
		if (currentBytes + Buffer.byteLength(section, "utf8") > budgetBytes) {
			omitted++;
			continue;
		}
		parts.push(section);
	}
	return {
		text: parts.join("\n\n---\n\n") || "(all worker outputs exceeded budget)",
		included: parts.length,
		omitted,
	};
}

/** Sum usage across results. contextTokens takes the max (high-water mark). */
export function aggregateUsage(results: Array<{ usage: UsageStats }>): UsageStats {
	const total = emptyUsage();
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
		if (r.usage.contextTokens > total.contextTokens) total.contextTokens = r.usage.contextTokens;
	}
	return total;
}

/** Last assistant message's text — joining ALL text parts, not just the first. */
export function getFinalOutput(messages: Array<{ role: string; content: unknown }>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const text = (msg.content as Array<{ type?: unknown; text?: unknown }>)
			.filter((p) => p.type === "text" && typeof p.text === "string")
			.map((p) => p.text as string)
			.join("");
		if (text) return text;
	}
	return "";
}

export function isFailedResult(result: { exitCode: number; stopReason?: string }): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

/**
 * Byte-budget truncation that never splits a UTF-8 sequence or UTF-16
 * surrogate pair. Appends a note about omitted bytes.
 */
export function truncateToBudget(output: string, capBytes: number, label = "Output"): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= capBytes) return output;
	let end = Math.min(output.length, capBytes);
	let truncated = output.slice(0, end);
	while (end > 0 && Buffer.byteLength(truncated, "utf8") > capBytes) {
		end -= 1;
		truncated = output.slice(0, end);
	}
	// Back off a trailing lone surrogate so we never emit ill-formed text.
	while (truncated.length > 0) {
		const last = truncated.charCodeAt(truncated.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) truncated = truncated.slice(0, -1);
		else break;
	}
	const omitted = byteLength - Buffer.byteLength(truncated, "utf8");
	return `${truncated}\n\n[${label} truncated: ${omitted} bytes omitted. Full output preserved in tool details.]`;
}

export function truncateParallelOutput(output: string): string {
	return truncateToBudget(output, PER_TASK_OUTPUT_CAP, "Output");
}

export function truncateSingleOutput(output: string): string {
	return truncateToBudget(output, SINGLE_OUTPUT_CAP, "Output");
}

/** Normalize an agent name for map keys (case/whitespace-insensitive). */
export function normalizeAgentName(name: string): string {
	return name.trim().toLowerCase();
}

export function isValidAgentName(name: string): boolean {
	return AGENT_NAME_RE.test(name);
}

/**
 * Validate a `--model` value from untrusted frontmatter. Rejects flag-like
 * values (`--foo`), empty strings, and overlong input.
 */
export function validateModelString(model: unknown): { model?: string; error?: string } {
	if (model === undefined) return {};
	if (typeof model !== "string") return { error: "model must be a string" };
	const trimmed = model.trim();
	if (!trimmed) return {};
	if (trimmed.startsWith("-")) return { error: `model must not look like a flag: ${trimmed.slice(0, 40)}` };
	if (!MODEL_RE.test(trimmed)) return { error: `model contains invalid characters: ${trimmed.slice(0, 40)}` };
	return { model: trimmed };
}

/**
 * Validate tool names from untrusted frontmatter for `--tools`. Drops
 * flag-like/invalid entries; reports what was dropped.
 */
export function validateToolList(tools: unknown): { tools?: string[]; dropped: string[] } {
	if (tools === undefined) return { dropped: [] };
	const raw = Array.isArray(tools) ? tools : typeof tools === "string" ? tools.split(",") : null;
	if (raw === null) return { dropped: [String(tools).slice(0, 60)] };
	const kept: string[] = [];
	const dropped: string[] = [];
	for (const t of raw) {
		if (typeof t !== "string") {
			dropped.push(String(t).slice(0, 60));
			continue;
		}
		const trimmed = t.trim();
		if (!trimmed) continue;
		if (TOOL_NAME_RE.test(trimmed) && !trimmed.startsWith("-")) kept.push(trimmed);
		else dropped.push(trimmed.slice(0, 60));
	}
	return { tools: kept.length > 0 ? kept : undefined, dropped };
}

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * Returns `undefined` when absent/empty (= all tools). Returns
 * `{ invalid: true }` when the value is present but not a string/array —
 * callers should treat this as fail-closed (skip the agent) rather than
 * silently granting all tools.
 */
export function parseToolList(
	value: unknown,
): { tools?: string[]; invalid?: boolean; dropped?: string[] } {
	if (value === undefined) return {};
	const { tools, dropped } = validateToolList(value);
	if (Array.isArray(value) || typeof value === "string") return { tools, dropped };
	return { invalid: true, dropped };
}

/**
 * Build a minimal environment for child `pi` processes. The parent env
 * intentionally does NOT propagate: API keys (`*_TOKEN`, `*_KEY`, `AWS_*`,
 * …) and machine-local state must never reach repo-controlled agent
 * contexts. Auth is file-based (`auth.json`), so children still work.
 * Agent identity (`PI_AGENT_NAME`/`PI_AGENT_FILE`) is set per child below so
 * the permissions extension loads the target agent's frontmatter layer.
 */
const PASSTHROUGH_EXACT = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"LANGUAGE",
	"TZ",
	"TMPDIR",
	"TMP",
	"TEMP",
	"TERM",
	"NO_COLOR",
	"CLICOLOR",
	"CLICOLOR_FORCE",
	"PAGER",
	"EDITOR",
]);

export function buildChildEnv(
	parentEnv: Record<string, string | undefined>,
	extra: Record<string, string>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(parentEnv)) {
		if (v === undefined) continue;
		if (PASSTHROUGH_EXACT.has(k) || k.startsWith("LC_")) out[k] = v;
	}
	for (const [k, v] of Object.entries(extra)) out[k] = v;
	return out;
}

/**
 * Append bounded stdout/stderr chunks. Returns the updated accumulator plus
 * whether the cap was hit (callers surface a `[truncated]` marker).
 *
 * Byte-correct: works on the UTF-8 encoding and never splits a code point.
 * Oldest bytes are kept as a prefix (stream head); callers tracking a line
 * buffer should separately bound un-newlined tails (see STDOUT_LINE_CAP).
 */
export function appendBounded(current: string, chunk: string, capBytes: number): { text: string; truncated: boolean } {
	const curBytes = Buffer.byteLength(current, "utf8");
	if (curBytes >= capBytes) return { text: current, truncated: true };
	const chunkBytes = Buffer.byteLength(chunk, "utf8");
	if (curBytes + chunkBytes <= capBytes) return { text: current + chunk, truncated: false };
	// Take the largest UTF-8-char-boundary prefix of `chunk` that fits.
	const buf = Buffer.from(chunk, "utf8");
	let end = capBytes - curBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
	const text = current + buf.subarray(0, end).toString("utf8");
	return { text, truncated: true };
}

/** Swarm: depth guard. Root dispatch is depth 0, workers run at depth+1. */
export function nextSwarmDepth(parentDepth: number): { depth: number } | { error: string } {
	if (!Number.isInteger(parentDepth) || parentDepth < 0) return { error: `invalid depth: ${parentDepth}` };
	const depth = parentDepth + 1;
	if (depth > MAX_SWARM_DEPTH) return { error: `max swarm depth ${MAX_SWARM_DEPTH} exceeded` };
	return { depth };
}

export function parseSwarmDepth(raw: unknown): number {
	const n = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : NaN;
	return Number.isInteger(n) && n >= 0 ? n : 0;
}

export function isValidRunId(runId: string): boolean {
	return SWARM_RUN_ID_RE.test(runId);
}

export function isValidWorkerId(id: string): boolean {
	return SWARM_WORKER_ID_RE.test(id);
}

export function generateRunId(now = Date.now(), rand?: number): string {
	const d = new Date(now);
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
	if (rand !== undefined) {
		// Deterministic path for tests: rand in [0, 1).
		const suffix = Math.floor(rand * 46656)
			.toString(36)
			.padStart(3, "0");
		// 4th char from fractional time to avoid collisions within same second.
		const extra = Math.floor((now % 1000) / 28)
			.toString(36)
			.padStart(1, "0");
		return `swarm-${stamp}-${suffix}${extra}`;
	}
	// Crypto path: 4 fully random base36 chars (~20.7 bits, 1.6M space) via
	// getRandomValues — no Math.random, no time-derived char (the timestamp
	// prefix already carries second precision).
	try {
		const g = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto);
		if (g) {
			const bytes = g(new Uint8Array(3));
			const n = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
			return `swarm-${stamp}-${(n % 1679616).toString(36).padStart(4, "0")}`;
		}
	} catch {
		/* fall through to Math.random */
	}
	return `swarm-${stamp}-${Math.floor(Math.random() * 1679616)
		.toString(36)
		.padStart(4, "0")}`;
}

/** Merge required swarm tools into a validated tool list (dedup, preserve order). */
export function ensureSwarmTools(existing: string[] | undefined): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const t of [...(existing ?? []), ...SWARM_REQUIRED_TOOLS]) {
		const k = t.toLowerCase();
		if (!seen.has(k)) {
			seen.add(k);
			out.push(t);
		}
	}
	return out;
}

export interface SwarmMessage {
	ts: string;
	from: string;
	to: string;
	body: string;
}

export function makeSwarmMessage(from: string, to: string, body: string, ts = new Date().toISOString()): string {
	return JSON.stringify({ ts, from, to, body });
}

export function parseSwarmMessageLine(line: string): SwarmMessage | null {
	if (!line.trim()) return null;
	try {
		const v = JSON.parse(line) as Partial<SwarmMessage>;
		if (typeof v.from !== "string" || typeof v.body !== "string") return null;
		return { ts: typeof v.ts === "string" ? v.ts : "", from: v.from, to: typeof v.to === "string" ? v.to : "all", body: v.body };
	} catch {
		return null;
	}
}

/** Short protocol injected into every swarm worker prompt (keeps blackboard discoverable). */
export function swarmProtocolSnippet(swarmDir: string, workerId: string, runId: string, depth: number): string {
	return [
		``,
		`Swarm context: run ${runId}, you are worker "${workerId}" at depth ${depth}/${MAX_SWARM_DEPTH}.`,
		`Blackboard dir (repo-local): ${swarmDir}`,
		` - Read tasks: tasks.jsonl | peers' outputs: done/<workerId>.md | inbox: inbox/${workerId}.jsonl`,
		` - Publish: write your findings to done/${workerId}.md, then append one JSON line`,
		`   {"ts":"<iso>","from":"${workerId}","to":"all","body":"<summary>"} to outbox.jsonl`,
		` - Message a peer: append {"from":"${workerId}","to":"<peerId>","body":"..."} to inbox/<peerId>.jsonl`,
		` - Recurse (depth < ${MAX_SWARM_DEPTH}): use subagent with ≤${MAX_SWARM_TOTAL} total workers.`,
	].join("\n");
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
	isAborted?: () => boolean,
	onSkipped?: (item: TIn, index: number) => TOut,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			// Drain the queue on abort: never start a new item once aborted.
			// Unstarted slots are left holes and filled via onSkipped below.
			if (isAborted?.()) return;
			const current = nextIndex++;
			if (current >= items.length) return;
			if (isAborted?.()) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	if (onSkipped) {
		for (let i = 0; i < items.length; i++) {
			// NOTE: reading a hole yields undefined; assignment fills it.
			if (results[i] === undefined) results[i] = onSkipped(items[i], i);
		}
	}
	return results;
}
