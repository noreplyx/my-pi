/**
 * Config loading + evaluation (agent-only — there is no global policy file).
 *
 * Precedence (first match wins):
 *   1. current agent's rules (from PI_AGENT_NAME / PI_AGENT_FILE; the main
 *      session with neither set falls back to `agents/main.md`)
 *   2. agent defaultAction (only when the agent file sets one)
 *   3. hardcoded fallback: ask
 *
 * The parent's `subagent` tool call is gated by the parent agent's layer
 * only; inner child tool calls are gated by the target agent's layer.
 *
 * Files are re-read when their mtime changes — no long-lived watchers
 * (per extension lifecycle guidance).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { matchTargets, matchToolName, hasInvalidRegex } from "./matcher.ts";
import { splitShellCommands } from "./shell-split.ts";
import {
	type PermissionAction,
	type PermissionRule,
	resolveAgentPermissionsRef,
	validateConfig,
	type ValidatedConfig,
} from "./schema.ts";

export interface EvalResult {
	action: PermissionAction;
	source: "agent" | "default";
	ruleIndex: number; // index within the agent's rules, -1 for default
	rule?: PermissionRule;
	target: string; // primary target string shown in prompts/logs
	/** Chain context for bash/powershell: which segment decided the result. */
	segment?: string;
	segmentIndex?: number; // 0-based within the chain
	segmentCount?: number;
}

interface CacheEntry {
	mtimeMs: number;
	exists: boolean;
	validated: ValidatedConfig;
	filePath: string;
}

const agentCache: { key: string; entry: CacheEntry | null } = { key: "", entry: null };

/** Hardcoded fallback when no agent layer applies. Fail closed: ask. */
export const FALLBACK_DEFAULT_ACTION: PermissionAction = "ask";

/** Agent file backing the main session (no PI_AGENT_NAME/PI_AGENT_FILE). */
export const MAIN_AGENT_NAME = "main";

/** Warned once per process when the removed PI_PERMISSIONS_FILE var is set. */
let warnedPermissionsFileEnv = false;

export function warnStalePermissionsFileEnv(): string | null {
	const v = process.env.PI_PERMISSIONS_FILE?.trim();
	if (!v || warnedPermissionsFileEnv) return null;
	warnedPermissionsFileEnv = true;
	return `PI_PERMISSIONS_FILE is set (${v}) but global permission files are no longer read — only per-agent frontmatter applies. Unset it to silence this warning.`;
}

function stripJsonComments(text: string): string {
	let out = "";
	let i = 0;
	let inStr: string | null = null;
	let escaped = false;
	while (i < text.length) {
		const c = text[i];
		const next = text[i + 1];
		if (inStr) {
			out += c;
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === inStr) inStr = null;
			i += 1;
			continue;
		}
		if (c === '"' || c === "'") {
			inStr = c;
			out += c;
			i += 1;
			continue;
		}
		if (c === "/" && next === "/") {
			while (i < text.length && text[i] !== "\n") i += 1;
			continue;
		}
		if (c === "/" && next === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
			i += 2;
			continue;
		}
		out += c;
		i += 1;
	}
	return out;
}

function readJsonFile(filePath: string): { value: unknown; error?: string } {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf-8");
	} catch (e: any) {
		return { value: undefined, error: `cannot read: ${e?.message ?? e}` };
	}
	try {
		return { value: JSON.parse(stripJsonComments(text)) };
	} catch (e: any) {
		return { value: undefined, error: `invalid JSON: ${e?.message ?? e}` };
	}
}

function loadFileIntoCache(filePath: string, prev: CacheEntry | null): CacheEntry {
	let stat: fs.Stats | null = null;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return { mtimeMs: 0, exists: false, validated: { config: { defaultAction: "ask", rules: [] }, errors: [] }, filePath };
	}
	if (prev && prev.exists && prev.mtimeMs === stat.mtimeMs && prev.filePath === filePath) return prev;
	const { value, error } = readJsonFile(filePath);
	if (error) {
		return {
			mtimeMs: stat.mtimeMs,
			exists: true,
			validated: { config: { defaultAction: "ask", rules: [] }, errors: [`${filePath}: ${error}`] },
			filePath,
		};
	}
	return { mtimeMs: stat.mtimeMs, exists: true, validated: validateConfig(value), filePath };
}

/** Resolve the current agent's permissions file/content from the environment. */
function currentAgentKey(): string {
	return `${process.env.PI_AGENT_NAME ?? ""}\0${process.env.PI_AGENT_FILE ?? ""}`;
}

/** Candidate `main.md` files backing the main session (user + project-local). */
function mainAgentCandidates(cwd?: string): string[] {
	const candidates = [path.join(getAgentDir(), "agents", `${MAIN_AGENT_NAME}.md`)];
	if (cwd) {
		try {
			let dir = cwd;
			while (true) {
				candidates.push(path.join(dir, CONFIG_DIR_NAME, "agents", `${MAIN_AGENT_NAME}.md`));
				const parent = path.dirname(dir);
				if (parent === dir) break;
				dir = parent;
			}
		} catch {
			// ignore — user-dir candidate still applies
		}
	}
	return candidates;
}

/** Load the main-session agent file (`main.md`). Null = none found. */
function loadMainEntry(cwd?: string): CacheEntry | null {
	for (const c of mainAgentCandidates(cwd)) {
		try {
			const stat = fs.statSync(c);
			const content = fs.readFileSync(c, "utf-8");
			const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
			const ref = resolveAgentPermissionsRef(frontmatter.permissions);
			if (ref.kind === "file") return loadFileIntoCache(path.resolve(path.dirname(c), ref.path), null);
			if (ref.kind === "inline")
				return { mtimeMs: stat.mtimeMs, exists: true, validated: validateConfig(ref.value), filePath: c };
			return { mtimeMs: stat.mtimeMs, exists: true, validated: validateConfig({}), filePath: c };
		} catch {
			continue;
		}
	}
	return null;
}

function loadAgentEntry(cwd?: string): CacheEntry | null {
	const name = process.env.PI_AGENT_NAME?.trim();
	const file = process.env.PI_AGENT_FILE?.trim();
	// Main session (no agent env): policy comes from agents/main.md.
	if (!name && !file) return loadMainEntry(cwd);
	const key = `${currentAgentKey()}\0${cwd ?? ""}`;
	if (agentCache.key === key && agentCache.entry) {
		// Revalidate mtime if file-backed. Negative (unknown-agent) entries are
		// NOT pinned — fall through and re-probe so a file created after a
		// miss is picked up without a reload.
		const e = agentCache.entry;
		if (!e.exists) {
			// fall through to reload
		} else {
			try {
				const stat = fs.statSync(e.filePath);
				if (stat.mtimeMs === e.mtimeMs) return e;
			} catch {
				// fall through to reload
			}
		}
	}
	let entry: CacheEntry | null = null;
	if (file) {
		try {
			const stat = fs.statSync(file);
			const content = fs.readFileSync(file, "utf-8");
			const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
			const ref = resolveAgentPermissionsRef(frontmatter.permissions);
			if (ref.kind === "none") {
				entry = { mtimeMs: stat.mtimeMs, exists: true, validated: validateConfig({}), filePath: file };
			} else if (ref.kind === "file") {
				const resolved = path.resolve(path.dirname(file), ref.path);
				entry = loadFileIntoCache(resolved, null);
			} else {
				entry = { mtimeMs: stat.mtimeMs, exists: true, validated: validateConfig(ref.value), filePath: file };
			}
		} catch (e: any) {
			entry = {
				mtimeMs: 0,
				exists: true,
				validated: { config: { defaultAction: "ask", rules: [] }, errors: [`agent file ${file}: ${e?.message ?? e}`] },
				filePath: file,
			};
		}
	} else if (name) {
		// No file path — look up <name>.md in user + nearest project agents dirs.
		const candidates = [path.join(getAgentDir(), "agents", `${name}.md`)];
		if (cwd) {
			try {
				let dir = cwd;
				while (true) {
					candidates.push(path.join(dir, CONFIG_DIR_NAME, "agents", `${name}.md`));
					const parent = path.dirname(dir);
					if (parent === dir) break;
					dir = parent;
				}
			} catch {
				// ignore — user-dir candidate still applies
			}
		}
		for (const c of candidates) {
			try {
				const stat = fs.statSync(c);
				const content = fs.readFileSync(c, "utf-8");
				const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
				const ref = resolveAgentPermissionsRef(frontmatter.permissions);
				if (ref.kind === "file") entry = loadFileIntoCache(path.resolve(path.dirname(c), ref.path), null);
				else if (ref.kind === "inline")
					entry = { mtimeMs: stat.mtimeMs, exists: true, validated: validateConfig(ref.value), filePath: c };
				else
					entry = { mtimeMs: stat.mtimeMs, exists: true, validated: validateConfig({}), filePath: c };
				break;
			} catch {
				continue;
			}
		}
		if (!entry) {
			entry = {
				mtimeMs: 0,
				exists: false,
				validated: { config: { defaultAction: "ask", rules: [] }, errors: [`unknown agent "${name}"`] },
				filePath: name,
			};
		}
	}
	agentCache.key = key;
	agentCache.entry = entry;
	return entry;
}

// ---------------------------------------------------------------------------
// Target extraction
// ---------------------------------------------------------------------------

function asString(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}

function pickPath(input: Record<string, unknown>): string | null {
	for (const k of ["path", "file_path", "filePath", "dir", "cwd"]) {
		const s = asString(input[k]);
		if (s) return s;
	}
	return null;
}

/**
 * Build match candidates for a tool call. First entry is the primary target
 * (used for display); matching succeeds if ANY candidate matches.
 */
export function buildTargets(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
	const lower = toolName.toLowerCase();
	if (lower === "bash" || lower === "powershell") {
		const cmd = asString(input.command) ?? "";
		return [cmd];
	}
	if (["read", "write", "edit"].includes(lower)) {
		const raw = pickPath(input) ?? "";
		const cands = [raw];
		if (raw) {
			try {
				const abs = path.resolve(cwd, raw);
				cands.push(abs);
				const rel = path.relative(cwd, abs);
				if (rel && !rel.startsWith("..")) cands.push(rel);
				else if (rel) cands.push(rel);
			} catch {
				// ignore
			}
		}
		return cands;
	}
	if (lower === "ls") {
		const raw = pickPath(input) ?? ".";
		return [raw, path.resolve(cwd, raw)];
	}
	if (lower === "find" || lower === "grep") {
		const p = pickPath(input) ?? ".";
		const pattern = asString(input.pattern) ?? "";
		return [pattern ? `${p}:${pattern}` : p, p, pattern].filter(Boolean);
	}
	try {
		const json = JSON.stringify(input);
		return [json];
	} catch {
		return [String(input)];
	}
}

/**
 * Short display path for prompts: cwd-relative when the target lives inside
 * cwd, otherwise the full absolute path (never hide where it points).
 */
export function shortPath(raw: string, cwd: string): string {
	if (!raw) return "";
	try {
		const abs = path.resolve(cwd, raw);
		const rel = path.relative(cwd, abs);
		if (!rel) return "."; // the cwd itself
		if (rel !== ".." && !rel.startsWith(`..${path.sep}`)) return rel;
		return abs;
	} catch {
		return raw;
	}
}

/**
 * Human-friendly one-line summary for a bash command.
 * Short commands pass through untouched (readable as-is). Long or
 * multi-step commands collapse to `first-step … (+N steps)` so the
 * permission dialog title stays scannable instead of dumping a 300-char
 * shell line. Pure — safe to unit-test without `pi`.
 */
function summarizeBash(cmd: string): string {
	const MAX_SINGLE = 100;
	if (cmd.length <= MAX_SINGLE) return cmd;
	const parts = cmd
		.split(/\s*(?:;|&&|\|\||\||\n)\s*/)
		.map((p) => p.trim())
		.filter(Boolean);
	if (parts.length <= 1) return truncate(cmd, MAX_SINGLE);
	const first = truncate(parts[0], 60);
	return `${first}… (+${parts.length - 1} more)`;
}

/**
 * One-line human summary for the permission prompt, in the form
 * `<action> <file path (never absolute when inside cwd)>`:
 * `write src/foo.txt`, `grep src "TODO"`, `bash npm test`,
 * `subagent general "List files in ~/.pi/agent…"`.
 * File tools show the (possibly relative) path; find/grep append the
 * pattern when present; bash shows the full command; subagent shows the
 * agent plus a task snippet (or parallel/swarm shape); anything else shows
 * compact `key=value` pairs. Home directories shorten to `~` (display
 * only — matching and audit keep absolute paths). Pure — safe to
 * unit-test without `pi`.
 */
export function describeCall(toolName: string, input: Record<string, unknown>, cwd: string): string {
	const lower = toolName.toLowerCase();
	if (["read", "write", "edit", "ls"].includes(lower)) {
		const raw = pickPath(input) ?? (lower === "ls" ? "." : "");
		const short = shortPath(raw, cwd);
		return short ? `${toolName} ${shortenHome(short)}` : `${toolName} (no path)`;
	}
	if (lower === "find" || lower === "grep") {
		const p = pickPath(input) ?? ".";
		const pattern = oneLine(asString(input.pattern) ?? "");
		const base = `${toolName} ${shortenHome(shortPath(p, cwd))}`;
		return pattern ? `${base} "${truncate(pattern, 60)}"` : base;
	}
	if (lower === "bash" || lower === "powershell") {
		const cmd = oneLine(asString(input.command) ?? "");
		if (!cmd) return `${toolName} (no command)`;
		// Human-readable: collapse long multi-step lines, shorten ~,
		// cap the whole summary so dialog titles stay one scannable line.
		return truncate(`${toolName} ${summarizeBash(shortenHomeInText(cmd))}`, 120);
	}
	if (lower === "subagent") {
		return `${toolName} ${describeSubagent(input)}`;
	}
	return `${toolName} ${compactArgs(input)}`;
}

/** Collapse whitespace/newlines to single spaces for one-line display. */
function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/** Truncate to max chars with an ellipsis. */
function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Shorten a leading home directory to `~` (display only, like pi core). */
export function shortenHome(p: string): string {
	const home = os.homedir();
	if (!home || home === path.sep) return p;
	if (p === home) return "~";
	if (p.startsWith(home + path.sep)) return `~${p.slice(home.length)}`;
	return p;
}

/** Replace every home-dir occurrence with `~` (display only). */
function shortenHomeInText(s: string): string {
	const home = os.homedir();
	if (!home || home === path.sep) return s;
	return s.split(home).join("~");
}

/** `agent "task snippet"` for one subagent item (single task or parallel step). */
function describeSubagentItem(item: unknown): string {
	if (typeof item !== "object" || item === null) return "";
	const o = item as Record<string, unknown>;
	const agent = asString(o.agent) ?? "";
	const task = oneLine(asString(o.task) ?? "");
	if (agent && task) return `${agent} "${truncate(shortenHomeInText(task), 60)}"`;
	if (agent) return agent;
	if (task) return `"${truncate(shortenHomeInText(task), 60)}"`;
	return "";
}

/** Agent name for one swarm worker (display only — no id, no task). */
function swarmAgentName(worker: unknown): string {
	if (typeof worker !== "object" || worker === null) return "";
	const o = worker as Record<string, unknown>;
	return asString(o.agent) ?? asString(o.id) ?? "";
}

/** Human shape for subagent calls: single, parallel, or swarm. */
function describeSubagent(input: Record<string, unknown>): string {
	const tasks = input.tasks;
	if (Array.isArray(tasks) && tasks.length > 0) {
		return `parallel (${tasks.length} task${tasks.length === 1 ? "" : "s"}): ${describeSubagentItem(tasks[0])}`;
	}
	const swarm = input.swarm;
	if (typeof swarm === "object" && swarm !== null) {
		const s = swarm as Record<string, unknown>;
		const workers = s.workers;
		if (Array.isArray(workers) && workers.length > 0) {
			const merger = s.merger;
			const mergerAgent =
				typeof merger === "object" && merger !== null ? swarmAgentName(merger) : "";
			const goal = truncate(shortenHomeInText(oneLine(asString(s.goal) ?? "")), 60);
			const header = `swarm (${workers.length} worker${workers.length === 1 ? "" : "s"})${mergerAgent ? " + merger" : ""}${goal ? `, goal: "${goal}"` : ""}`;
			const counts = new Map<string, number>();
			for (const w of workers) {
				const name = swarmAgentName(w) || "worker";
				counts.set(name, (counts.get(name) ?? 0) + 1);
			}
			const lines = [...counts.entries()].map(([name, n]) => (n > 1 ? `  - ${name} ×${n}` : `  - ${name}`));
			if (mergerAgent) lines.push(`  + merger:${mergerAgent}`);
			return [header, ...lines].join("\n");
		}
	}
	return describeSubagentItem(input) || "(no details)";
}

/** Compact `key=value` pairs (transcript-row convention), one line, capped. */
function compactArgs(input: Record<string, unknown>): string {
	const pairs = Object.entries(input).map(([k, v]) => {
		const rendered = typeof v === "string" ? JSON.stringify(oneLine(v)) : (JSON.stringify(v) ?? String(v));
		return `${k}=${rendered}`;
	});
	return truncate(pairs.join(" ") || "(no args)", 100);
}

/** Absolute, trailing-separator-free path form (filesystem root stays "/"). */
export function normalizeDir(p: string): string {
	const norm = path.normalize(p);
	if (norm.length > 1 && norm.endsWith(path.sep)) return norm.slice(0, -path.sep.length);
	return norm;
}

/**
 * Absolute file path for a tool call, for directory-grant matching.
 * File tools only; null for bash/non-path tools or when no path is present.
 * Uses the path part of the input (not the `path:pattern` display target).
 */
export function resolveGrantPath(toolName: string, input: Record<string, unknown>, cwd: string): string | null {
	if (!isPathTool(toolName)) return null;
	const raw = pickPath(input);
	if (!raw) return null;
	try {
		return normalizeDir(path.resolve(cwd, raw));
	} catch {
		return null;
	}
}

/**
 * Absolute directory a session grant should cover for this tool call.
 * File tools only; null for bash/non-path tools or when no path is present.
 * An existing directory target grants itself (e.g. `ls` of that dir);
 * anything else (existing file, not-yet-created path) grants its parent.
 * Never throws — falls back to the parent directory when stat fails.
 */
export function resolveGrantDir(toolName: string, input: Record<string, unknown>, cwd: string): string | null {
	const p = resolveGrantPath(toolName, input, cwd);
	if (!p) return null;
	try {
		if (fs.statSync(p).isDirectory()) return normalizeDir(p);
	} catch {
		// Nonexistent path (e.g. file to be created) — treat as a file.
	}
	return path.dirname(p);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Precedence (first applicable wins — agent-only, no global layer):
 *   1. Agent rules in order.
 *   2. Agent defaultAction (only when the agent file sets one).
 *   3. Hardcoded fallback: ask.
 *
 * Parent `subagent` invocations are gated by the parent agent's layer;
 * inner child calls are gated by the target agent's layer.
 */
/** True for tools whose match targets are file paths (segment-aware globs). */
function isPathTool(toolName: string): boolean {
	const lower = toolName.toLowerCase();
	return ["read", "write", "edit", "ls", "find", "grep"].includes(lower);
}

export function evaluate(toolName: string, input: Record<string, unknown>, cwd: string): EvalResult {
	const targets = buildTargets(toolName, input, cwd);
	const primary = targets[0] ?? "";
	const pathMode = isPathTool(toolName);

	const agentEntry = loadAgentEntry(cwd);
	const agentRules = agentEntry?.exists ? agentEntry.validated.config.rules : [];

	// Fail-closed broken patterns: an uncompilable regex never matches via
	// `matchOne` (returns false). For `deny` that would be fail-open, so a
	// deny rule with a broken pattern is treated as matching everything its
	// tool selector matches; a broken `allow`/`ask` is treated as never
	// matching (falls through to default). Both cases are also reported by
	// validation (R1) — this only decides the runtime direction.
	const firstMatch = (rules: PermissionRule[], cands: string[]) => {
		for (let i = 0; i < rules.length; i++) {
			const r = rules[i];
			if (!matchToolName(r.tool, toolName)) continue;
			if (hasInvalidRegex(r.match)) {
				if (r.action === "deny") return { index: i, rule: r };
				continue;
			}
			if (!matchTargets(r.match, cands, pathMode)) continue;
			return { index: i, rule: r };
		}
		return null;
	};

	/** Evaluate one target string through the agent-only precedence. */
	const evalOne = (cands: string[], displayTarget: string): EvalResult => {
		// 1. Agent rules in order.
		const agentHit = firstMatch(agentRules, cands);
		if (agentHit) {
			return { action: agentHit.rule.action, source: "agent", ruleIndex: agentHit.index, rule: agentHit.rule, target: displayTarget };
		}

		// 2. Agent default (explicit only — otherwise fall through).
		if (agentEntry?.exists && agentEntry.validated.hasDefault) {
			return { action: agentEntry.validated.config.defaultAction, source: "agent", ruleIndex: -1, target: displayTarget };
		}

		// 3. Hardcoded fallback (fail closed: ask).
		return { action: FALLBACK_DEFAULT_ACTION, source: "default", ruleIndex: -1, target: displayTarget };
	};

	// Chain-aware shell evaluation (strict): split `bash`/`powershell` on
	// `; && || | |& &` + newlines (quote-aware) and evaluate each segment
	// independently. Any segment deny → whole call deny; all allow → allow;
	// otherwise ask. Single commands take the same path with one segment.
	const lower = toolName.toLowerCase();
	if (lower === "bash" || lower === "powershell") {
		try {
			const segments = splitShellCommands(primary);
			if (segments.length > 1) {
				const results = segments.map((seg) => evalOne([seg], primary));
				// Deny wins — report the first denying segment.
				for (let i = 0; i < results.length; i++) {
					if (results[i].action === "deny") {
						return { ...results[i], target: primary, segment: segments[i], segmentIndex: i, segmentCount: segments.length };
					}
				}
				const firstNonAllow = results.findIndex((r) => r.action !== "allow");
				if (firstNonAllow === -1) {
					return { ...results[0], action: "allow", target: primary, segment: segments[0], segmentIndex: 0, segmentCount: segments.length };
				}
				return {
					...results[firstNonAllow],
					target: primary,
					segment: segments[firstNonAllow],
					segmentIndex: firstNonAllow,
					segmentCount: segments.length,
				};
			}
		} catch {
			// Fail closed to whole-string evaluation below.
		}
	}

	return evalOne(targets, primary);
}

export function describeStatus(cwd?: string): {
	agentName: string | null;
	agentFile: string | null;
	agentExists: boolean;
	agentErrors: string[];
	agentRuleCount: number;
	agentDefault: string | null;
} {
	const a = loadAgentEntry(cwd);
	return {
		agentName: process.env.PI_AGENT_NAME?.trim() || (a?.exists ? MAIN_AGENT_NAME : null),
		agentFile: process.env.PI_AGENT_FILE?.trim() || a?.filePath || null,
		agentExists: a?.exists ?? false,
		agentErrors: a?.validated.errors ?? [],
		agentRuleCount: a?.validated.config.rules.length ?? 0,
		agentDefault: a?.exists && a.validated.hasDefault ? a.validated.config.defaultAction : null,
	};
}

export function reloadAll(): void {
	agentCache.key = "";
	agentCache.entry = null;
	agentScanCache.clear();
}

// ---------------------------------------------------------------------------
// Startup validation support: load every agent file that declares permissions
// ---------------------------------------------------------------------------

export interface AgentFileReport {
	filePath: string;
	/** Short display path for diagnostics. */
	label: string;
	agentName: string;
	validated: ValidatedConfig;
}

function shortLabel(filePath: string, cwd: string, projectRoot: string | null): string {
	const agentDir = getAgentDir();
	if (filePath.startsWith(agentDir + path.sep)) return filePath.slice(agentDir.length + 1);
	// Prefer a cwd-relative label when the file is underneath cwd …
	const rel = path.relative(cwd, filePath);
	if (rel && !rel.startsWith("..") && rel.length < filePath.length) return rel;
	// … otherwise anchor project files at their project root (`myproj/.pi/agents/x.md`).
	if (projectRoot && (filePath === projectRoot || filePath.startsWith(projectRoot + path.sep))) {
		return path.join(path.basename(projectRoot), path.relative(projectRoot, filePath));
	}
	return filePath;
}

function findNearestProjectAgents(cwd: string): { agentsDir: string; root: string } | null {
	let dir = cwd;
	while (true) {
		const agentsDir = path.join(dir, CONFIG_DIR_NAME, "agents");
		try {
			if (fs.statSync(agentsDir).isDirectory()) return { agentsDir, root: dir };
		} catch {
			// keep walking up
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Read + validate one agent file. Null = no permissions block, nothing to report. Never throws. */
function readAgentFileReport(filePath: string, cwd: string, projectRoot: string | null): AgentFileReport | null {
	const label = shortLabel(filePath, cwd, projectRoot);
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
		const ref = resolveAgentPermissionsRef(frontmatter.permissions);
		if (ref.kind === "none") return null; // no permissions block — nothing to report
		const agentName = typeof frontmatter.name === "string" ? frontmatter.name : path.basename(filePath);
		if (ref.kind === "file") {
			const resolved = path.resolve(path.dirname(filePath), ref.path);
			const { value, error } = readJsonFile(resolved);
			return {
				filePath,
				label,
				agentName,
				validated: error
					? { config: { defaultAction: "ask", rules: [] }, errors: [`${resolved}: ${error}`], hasDefault: false }
					: validateConfig(value),
			};
		}
		return { filePath, label, agentName, validated: validateConfig(ref.value) };
	} catch (e: any) {
		return {
			filePath,
			label,
			agentName: path.basename(filePath),
			validated: { config: { defaultAction: "ask", rules: [] }, errors: [`cannot read: ${e?.message ?? e}`], hasDefault: false },
		};
	}
}

interface AgentScanCacheEntry {
	mtimeMs: number;
	cwd: string;
	projectRoot: string | null;
	report: AgentFileReport | null;
}

// File reads are cached by mtime (readdir itself stays uncached — it is cheap
// and is the authoritative source for added/removed files).
const agentScanCache = new Map<string, AgentScanCacheEntry>();

function scanAgentFile(filePath: string, cwd: string, projectRoot: string | null): AgentFileReport | null {
	let mtimeMs = 0;
	try {
		mtimeMs = fs.statSync(filePath).mtimeMs;
	} catch {
		agentScanCache.delete(filePath);
		return null;
	}
	const prev = agentScanCache.get(filePath);
	if (prev && prev.mtimeMs === mtimeMs) {
		if (!prev.report || (prev.cwd === cwd && prev.projectRoot === projectRoot)) return prev.report;
		// Same content, different viewer location — relabel without re-reading.
		const relabeled: AgentFileReport = { ...prev.report, label: shortLabel(filePath, cwd, projectRoot) };
		agentScanCache.set(filePath, { mtimeMs, cwd, projectRoot, report: relabeled });
		return relabeled;
	}
	const report = readAgentFileReport(filePath, cwd, projectRoot);
	agentScanCache.set(filePath, { mtimeMs, cwd, projectRoot, report });
	return report;
}

/** Every agent file (user + project-local) that declares a permissions block. */
export function loadAllAgentFiles(cwd: string): AgentFileReport[] {
	const seen = new Set<string>();
	const out: AgentFileReport[] = [];
	const project = findNearestProjectAgents(cwd);
	const projectRoot = project?.root ?? null;
	const dirs = [path.join(getAgentDir(), "agents")];
	if (project) dirs.push(project.agentsDir);
	for (const dir of dirs) {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.name.endsWith(".md")) continue;
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;
			const filePath = path.join(dir, entry.name);
			if (seen.has(filePath)) continue;
			seen.add(filePath);
			const report = scanAgentFile(filePath, cwd, projectRoot);
			if (report) out.push(report);
		}
	}
	// Drop cache entries for files gone from every scanned dir (readdir is authoritative).
	for (const key of [...agentScanCache.keys()]) {
		if (!seen.has(key) && dirs.some((d) => key === d || key.startsWith(d + path.sep))) {
			agentScanCache.delete(key);
		}
	}
	return out;
}
