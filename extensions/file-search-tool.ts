/**
 * file-search-tool — native single-file filesystem discovery extension for pi.
 *
 * Unifies `glob` | `ls` | `find` | `grep` behind one mode-discriminated tool
 * with parallel, no-cache, zero-dependency internals plus bash steering that
 * nudges the agent away from slow/spammy shell discovery commands.
 *
 * Design rules (enforced throughout this file):
 * - Single file, zero npm dependencies. Only `node:fs/promises` and
 *   `node:path` are used (`node:os` is also allowed but unneeded).
 * - No cache: every call uses per-call locals only. No shared mutable state
 *   (module scope holds frozen constants only), so all entry points are
 *   reentrant and safe under parallel tool execution.
 * - Pure JSON output: `execute` never throws; failures become error
 *   envelopes. No caps: full unbounded results; redaction is display-only
 *   before `JSON.stringify`.
 * - Redaction is display-only: file contents are never modified, only the
 *   text returned to the model is masked.
 * - Never execs/spawns anything; no timers, sockets, or file watchers.
 */

import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Static, Type } from "typebox";

/* ------------------------------------------------------------------ */
/* Uncapped: no hard result/size/depth caps. Single canonical home.    */
/* ------------------------------------------------------------------ */

const CONCURRENCY = 32;

/* ------------------------------------------------------------------ */
/* Unified mode-discriminated TypeBox schema.                          */
/* ------------------------------------------------------------------ */

const GlobParams = Type.Object({
	mode: Type.Literal("glob"),
	pattern: Type.String({ description: "Glob pattern supporting * ** ? and {a,b} brace expansion (e.g. 'src/**.{ts,js}', '*.{json,md}')" }),
	cwd: Type.Optional(Type.String({ description: "Base directory. Absolute or relative to session cwd. Defaults to session cwd." })),
	includeHidden: Type.Optional(Type.Boolean({ default: true, description: "Include dotfiles/dot-directories. Default true (show everything)." })),
	respectGitignore: Type.Optional(Type.Boolean({ default: false, description: "Filter via .gitignore. Default false (show everything)." })),
	maxResults: Type.Optional(Type.Integer({ minimum: 0, description: "Max files returned. Unbounded; omit for all. Must be >= 0 (-1 is invalid)." })),
});

const LsParams = Type.Object({
	mode: Type.Literal("ls"),
	path: Type.Optional(Type.String({ description: "Directory to list. Absolute or relative to session cwd. Defaults to session cwd." })),
	long: Type.Optional(Type.Boolean({ default: false, description: "Include size + mtime via stat. Default false (Dirent only, fast)." })),
	recursive: Type.Optional(Type.Boolean({ default: false, description: "Walk subdirectories. Default false." })),
	maxDepth: Type.Optional(Type.Integer({ minimum: 0, description: "Max depth below path (1 = top level only). Unbounded; omit for full depth when recursive (defaults to 1 when not recursive). Must be >= 0 (-1 is invalid)." })),
	maxResults: Type.Optional(Type.Integer({ minimum: 0, description: "Max entries returned. Unbounded; omit for all. Must be >= 0 (-1 is invalid)." })),
});

const FindParams = Type.Object({
	mode: Type.Literal("find"),
	root: Type.Optional(Type.String({ description: "Root directory. Absolute or relative to session cwd. Defaults to session cwd." })),
	type: Type.Optional(
		Type.Union([Type.Literal("file"), Type.Literal("dir"), Type.Literal("both")], {
			default: "both",
			description: "Entry kind to return.",
		}),
	),
	namePattern: Type.Optional(Type.String({ description: "Glob matched against the basename (e.g. '*.test.ts')." })),
	maxDepth: Type.Optional(Type.Integer({ minimum: 0, description: "Max depth below root. Unbounded; omit for full depth. Must be >= 0 (-1 is invalid)." })),
	minSize: Type.Optional(Type.Integer({ description: "Minimum file size in bytes. Applies to files only." })),
	maxSize: Type.Optional(Type.Integer({ description: "Maximum file size in bytes. Applies to files only." })),
	modifiedAfter: Type.Optional(Type.String({ description: "ISO date string; keep entries modified after it." })),
	modifiedBefore: Type.Optional(Type.String({ description: "ISO date string; keep entries modified before it." })),
	maxResults: Type.Optional(Type.Integer({ minimum: 0, description: "Max entries returned. Unbounded; omit for all. Must be >= 0 (-1 is invalid)." })),
});

const GrepParams = Type.Object({
	mode: Type.Literal("grep"),
	pattern: Type.String({ description: "Text to find. Literal by default; set regex:true for RegExp." }),
	regex: Type.Optional(Type.Boolean({ default: false, description: "Treat pattern as a JavaScript RegExp. Default false." })),
	caseSensitive: Type.Optional(Type.Boolean({ default: true, description: "Case-sensitive matching. Default true." })),
	root: Type.Optional(Type.String({ description: "Root directory. Absolute or relative to session cwd. Defaults to session cwd." })),
	include: Type.Optional(Type.String({ description: "Glob filtering which files are searched (e.g. '*.ts')." })),
	beforeContext: Type.Optional(Type.Integer({ minimum: 0, description: "Context lines before each match. Unbounded non-negative integer; omit or 0 for none. Must be >= 0 (-1 is invalid)." })),
	afterContext: Type.Optional(Type.Integer({ minimum: 0, description: "Context lines after each match. Unbounded non-negative integer; omit or 0 for none. Must be >= 0 (-1 is invalid)." })),
	maxMatches: Type.Optional(Type.Integer({ minimum: 0, description: "Max matches returned. Unbounded; omit for all. Must be >= 0 (-1 is invalid)." })),
	maxFileSize: Type.Optional(Type.Integer({ minimum: 0, description: "Max file size in bytes. Unbounded; omit to search all sizes (binary gate still applies). Must be >= 0 (-1 is invalid)." })),
});

const FileToolParameters = Type.Union([GlobParams, LsParams, FindParams, GrepParams]);

type FileToolParams = Static<typeof FileToolParameters>;

/* ------------------------------------------------------------------ */
/* Shared pure reentrant internals (per-call locals only).             */
/* ------------------------------------------------------------------ */

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

function isFsIgnorable(error: unknown): boolean {
	const code = (error as { code?: unknown }).code;
	return code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ENOTDIR";
}

function checkAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

/** Resolve a user-supplied path: absolute stays, relative joins session cwd. */
function resolveBase(raw: string | undefined, sessionCwd: string, fallback: string): string {
	const value = raw !== undefined && raw.trim().length > 0 ? raw : fallback;
	return isAbsolute(value) ? resolve(value) : resolve(sessionCwd, value);
}

/** Unbounded limit: omit (undefined) means omitValue; finite values are honored as-is.
 * Rejects negative values (including the legacy -1 sentinel) with a validation error. */
function unboundedLimit(raw: unknown, name: string, omitValue: number): number {
	if (raw === undefined) return omitValue;
	if (typeof raw !== "number" || !Number.isFinite(raw)) {
		throw new Error(`Invalid ${name}: must be a non-negative integer (omit for unbounded, -1 is invalid)`);
	}
	if (raw < 0) throw new Error(`Invalid ${name}: must be >= 0 (got ${raw}); -1 is invalid, omit for unbounded`);
	return Math.floor(raw);
}

/** Unbounded count: omit (undefined) means all; finite values are honored as-is. */
function uncappedCount(raw: unknown, name: string): number {
	return unboundedLimit(raw, name, Number.POSITIVE_INFINITY);
}

/** Unbounded depth: omit (undefined) means full depth; honors finite values as-is. */
function uncappedDepth(raw: unknown, name: string): number {
	return unboundedLimit(raw, name, Number.POSITIVE_INFINITY);
}

/** Unbounded context: omit (undefined) means 0; honors any finite non-negative value. */
function uncappedContext(raw: unknown, name: string): number {
	if (raw === undefined) return 0;
	if (typeof raw !== "number" || !Number.isFinite(raw)) {
		throw new Error(`Invalid ${name}: must be a non-negative integer (omit or 0 for none, -1 is invalid)`);
	}
	if (raw < 0) throw new Error(`Invalid ${name}: must be >= 0 (got ${raw}); -1 is invalid`);
	return Math.floor(raw);
}

/** Concurrency limiter (~32 wide): chunked Promise.allSettled, skips rejects. */
async function mapSettled<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<Array<R | undefined>> {
	const out: Array<R | undefined> = new Array(items.length);
	for (let i = 0; i < items.length; i += limit) {
		const chunk = items.slice(i, i + limit);
		const settled = await Promise.allSettled(chunk.map((item, j) => fn(item, i + j)));
		for (let j = 0; j < settled.length; j += 1) {
			const s = settled[j];
			out[i + j] = s.status === "fulfilled" ? s.value : undefined;
		}
	}
	return out;
}

/* ---------------------- brace expansion ---------------------- */

/**
 * Expand `{a,b,c}` groups (including nested like `{a,{b,c}}`) into multiple
 * patterns. Pure, zero-dependency, no shared state.
 * - Multiple groups multiply out: `p-{a,b}-{c,d}` -> 4 patterns.
 * - Empty alternatives are kept: `file.{ts,}` matches `file.ts` + `file.`.
 * - A brace pair without a top-level comma is literal: `file{a}.txt`.
 * - Unbalanced braces are literal: `src/{foo` matches nothing special.
 * - Backslash escapes the next char (`\{`, `\}`, `\,`, `\\`); the
 *   backslash is stripped from the final output.
 */
function splitBraceAlternatives(inner: string): string[] | undefined {
	const parts: string[] = [];
	let depth = 0;
	let current = "";
	let hasTopLevelComma = false;
	for (let i = 0; i < inner.length; i += 1) {
		const c = inner[i];
		if (c === "\\" && i + 1 < inner.length) {
			current += c + inner[i + 1];
			i += 1;
			continue;
		}
		if (c === "{") {
			depth += 1;
			current += c;
		} else if (c === "}") {
			depth = Math.max(0, depth - 1);
			current += c;
		} else if (c === "," && depth === 0) {
			hasTopLevelComma = true;
			parts.push(current);
			current = "";
		} else {
			current += c;
		}
	}
	if (!hasTopLevelComma) return undefined;
	parts.push(current);
	return parts;
}

/** Remove one level of `\{ \} \, \\` escaping after expansion. */
function unescapeBracePattern(value: string): string {
	return value.replace(/\\([{},\\])/g, "$1");
}

function expandBracesRaw(pattern: string): string[] {
	let open = -1;
	for (let i = 0; i < pattern.length; i += 1) {
		const c = pattern[i];
		if (c === "\\") {
			i += 1; // skip escaped char
			continue;
		}
		if (c === "{") {
			open = i;
			break;
		}
	}
	if (open === -1) return [pattern];
	let depth = 0;
	let close = -1;
	for (let i = open; i < pattern.length; i += 1) {
		const c = pattern[i];
		if (c === "\\") {
			i += 1;
			continue;
		}
		if (c === "{") depth += 1;
		else if (c === "}") {
			depth -= 1;
			if (depth === 0) {
				close = i;
				break;
			}
		}
	}
	if (close === -1) return [pattern]; // unbalanced -> literal
	const alternatives = splitBraceAlternatives(pattern.slice(open + 1, close));
	const prefix = pattern.slice(0, open);
	const suffix = pattern.slice(close + 1);
	if (alternatives === undefined) {
		// No top-level comma: braces are literal; expand only the tail.
		return expandBracesRaw(suffix).map((tail) => `${prefix}${pattern.slice(open, close + 1)}${tail}`);
	}
	const out: string[] = [];
	for (const alt of alternatives) {
		for (const expanded of expandBracesRaw(`${prefix}${alt}${suffix}`)) out.push(expanded);
	}
	return out;
}

/** Public entry: expand all brace groups, then strip escape backslashes. */
function expandBraces(pattern: string): string[] {
	return expandBracesRaw(pattern).map(unescapeBracePattern);
}

/** Zero-dep glob (*, **, ?) to RegExp. */
function globToRegExp(glob: string): RegExp {
	const normalized = glob.replace(/\\/g, "/");
	let source = "^";
	let i = 0;
	while (i < normalized.length) {
		const c = normalized[i];
		if (c === "*") {
			if (normalized[i + 1] === "*") {
				if (normalized[i + 2] === "/") {
					source += "(?:.*/)?";
					i += 3;
				} else {
					source += ".*";
					i += 2;
				}
			} else {
				source += "[^/]*";
				i += 1;
			}
		} else if (c === "?") {
			source += "[^/]";
			i += 1;
		} else if (c === "[") {
			const close = normalized.indexOf("]", i + 1);
			if (close === -1) {
				source += "\\[";
				i += 1;
			} else {
				source += normalized.slice(i, close + 1);
				i = close + 1;
			}
		} else if ("\\.+^${}()|".includes(c)) {
			source += `\\${c}`;
			i += 1;
		} else {
			source += c;
			i += 1;
		}
	}
	source += "$";
	return new RegExp(source);
}

/** NUL-byte heuristic: binary when the first 8KB contains a zero byte. */
function isBinaryBuffer(buf: Buffer): boolean {
	const n = Math.min(buf.length, 8192);
	for (let i = 0; i < n; i += 1) {
		if (buf[i] === 0) return true;
	}
	return false;
}

/* Secret redaction (display-only): patterns compiled fresh per call so no
 * shared RegExp lastIndex state can leak between parallel invocations. */
const SECRET_SOURCES: Array<[string, string, string]> = [
	["AKIA[0-9A-Z]{16}", "g", "***AKIA-REDACTED***"],
	["github_pat_[A-Za-z0-9_]{10,}", "g", "***GITHUB-PAT-REDACTED***"],
	["\\bgh[pousr]_[A-Za-z0-9]{20,}", "g", "***GITHUB-TOKEN-REDACTED***"],
	["\\bxox[bpas]-[A-Za-z0-9-]{10,}", "g", "***SLACK-TOKEN-REDACTED***"],
	["sk-(live|test)-[A-Za-z0-9]{10,}", "g", "***API-KEY-REDACTED***"],
	["-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----", "g", "***PRIVATE-KEY-REDACTED***"],
	["-----END [A-Z0-9 ]*PRIVATE KEY-----", "g", "***PRIVATE-KEY-REDACTED***"],
	["-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----", "g", "***PRIVATE-KEY-REDACTED***"],
];

const SECRET_KEY_RE = /(SECRET|TOKEN|KEY|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|SESSION)/i;
const ENV_LINE_RE = /^(\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(.+?)(\s*)$/;
/* Private key files: grep redacts per line, so the multi-line PEM block can
 * never match line-by-line and base64 body lines would leak. Mask every
 * returned line from key files instead. */
const KEY_FILE_RE = /\.(pem|key|p12|pfx|asc|keystore|jks|sshkey)$/i;
const KEY_FILE_MASKED = "***PRIVATE-KEY-REDACTED***";

function redactMatchLine(rawLine: string, isKeyFile: boolean): string {
	if (isKeyFile) return KEY_FILE_MASKED;
	return redactSecrets(rawLine);
}

function redactSecrets(text: string): string {
	let out = text;
	for (const [source, flags, replacement] of SECRET_SOURCES) {
		out = out.replace(new RegExp(source, flags), replacement);
	}
	out = out
		.split("\n")
		.map((line) => {
			const m = ENV_LINE_RE.exec(line);
			if (m !== null && SECRET_KEY_RE.test(m[1])) return `${m[1]}***${m[3]}`;
			return line;
		})
		.join("\n");
	return out;
}

/* ------------------------- ignore support ------------------------- */

interface IgnoreRule {
	negative: boolean;
	dirOnly: boolean;
	rooted: boolean;
	matcher: RegExp;
	prefix: string | undefined;
}

function parseIgnoreRules(text: string): IgnoreRule[] {
	const rules: IgnoreRule[] = [];
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		const negative = line.startsWith("!");
		const body = (negative ? line.slice(1) : line).trim();
		if (body.length === 0) continue;
		const dirOnly = body.endsWith("/");
		const stripped = dirOnly ? body.slice(0, -1) : body;
		const rooted = stripped.startsWith("/") || stripped.includes("/");
		const core = stripped.startsWith("/") ? stripped.slice(1) : stripped;
		rules.push({
			negative,
			dirOnly,
			rooted,
			matcher: globToRegExp(dirOnly ? basename(core) : core),
			prefix: dirOnly ? core : undefined,
		});
	}
	return rules;
}

function isIgnoredRel(rel: string, name: string, isDir: boolean, rules: readonly IgnoreRule[]): boolean {
	let ignored = false;
	for (const rule of rules) {
		let hit = false;
		if (rule.dirOnly && rule.prefix !== undefined) {
			hit = isDir && (rel === rule.prefix || rel.startsWith(`${rule.prefix}/`));
			if (!hit) hit = rel.startsWith(`${rule.prefix}/`) || rel === rule.prefix;
		} else if (rule.rooted) {
			hit = rule.matcher.test(rel);
		} else {
			hit = rule.matcher.test(name) || rule.matcher.test(rel);
		}
		if (hit) ignored = !rule.negative;
	}
	return ignored;
}

async function loadIgnoreRules(rootAbs: string, respectGitignore: boolean): Promise<IgnoreRule[]> {
	if (!respectGitignore) return [];
	try {
		const text = await readFile(join(rootAbs, ".gitignore"), "utf8");
		return parseIgnoreRules(text);
	} catch {
		return [];
	}
}

/* --------------------------- tree walker --------------------------- */

interface TreeNode {
	absPath: string;
	relPath: string;
	isDirectory: boolean;
	isBrokenLink: boolean;
}

interface CollectOptions {
	includeHidden: boolean;
	maxDepth: number;
	ignoreRules: readonly IgnoreRule[];
	skipGitDir: boolean;
	includeDirs: boolean;
	includeFiles: boolean;
	signal?: AbortSignal;
}

async function collectTree(rootAbs: string, opts: CollectOptions): Promise<TreeNode[]> {
	// visited tracks only the root realpath + symlink-dir targets (not every
	// descended directory). Depth is unbounded (maxDepth defaults to Infinity,
	// childDepth > maxDepth prunes only when the caller passes a finite limit);
	// loop safety relies on the visited symlink guard.
	const visited = new Set<string>();
	const nodes: TreeNode[] = [];
	try {
		visited.add(await realpath(rootAbs));
	} catch {
		/* root may vanish mid-call; walk attempt below reports it */
	}
	const stack: Array<{ dir: string; depth: number }> = [{ dir: rootAbs, depth: 0 }];
	while (stack.length > 0) {
		if (checkAborted(opts.signal)) break;
		const current = stack.pop() as { dir: string; depth: number };
		let dirents;
		try {
			dirents = await readdir(current.dir, { withFileTypes: true });
		} catch (error) {
			if (isFsIgnorable(error)) continue;
			throw error;
		}
		for (const entry of dirents) {
			const name = entry.name;
			if (!opts.includeHidden && name.startsWith(".")) continue;
			const absPath = join(current.dir, name);
			const relPath = relative(rootAbs, absPath).split(sep).join("/");
			if (opts.skipGitDir && (relPath === ".git" || relPath.startsWith(".git/"))) continue;
			const childDepth = current.depth + 1;
			if (childDepth > opts.maxDepth) continue;

			if (entry.isSymbolicLink()) {
				let target: string | undefined;
				try {
					target = await realpath(absPath);
				} catch {
					if (opts.includeFiles) nodes.push({ absPath, relPath, isDirectory: false, isBrokenLink: true });
					continue;
				}
				let targetStat;
				try {
					targetStat = await stat(target);
				} catch (error) {
					if (isFsIgnorable(error)) {
						if (opts.includeFiles) nodes.push({ absPath, relPath, isDirectory: false, isBrokenLink: true });
						continue;
					}
					throw error;
				}
				if (targetStat.isDirectory()) {
					if (isIgnoredRel(relPath, name, true, opts.ignoreRules)) continue;
					if (visited.has(target)) continue; // symlink loop guard
					visited.add(target);
					if (opts.includeDirs) nodes.push({ absPath, relPath, isDirectory: true, isBrokenLink: false });
					if (childDepth < opts.maxDepth) stack.push({ dir: absPath, depth: childDepth });
				} else if (targetStat.isFile()) {
					if (isIgnoredRel(relPath, name, false, opts.ignoreRules)) continue;
					if (opts.includeFiles) nodes.push({ absPath, relPath, isDirectory: false, isBrokenLink: false });
				}
				continue;
			}

			if (entry.isDirectory()) {
				if (isIgnoredRel(relPath, name, true, opts.ignoreRules)) continue;
				if (opts.includeDirs) nodes.push({ absPath, relPath, isDirectory: true, isBrokenLink: false });
				if (childDepth < opts.maxDepth) stack.push({ dir: absPath, depth: childDepth });
			} else if (entry.isFile()) {
				if (isIgnoredRel(relPath, name, false, opts.ignoreRules)) continue;
				if (opts.includeFiles) nodes.push({ absPath, relPath, isDirectory: false, isBrokenLink: false });
			}
			/* sockets/fifos/devices are skipped: not searchable content */
		}
	}
	return nodes;
}

async function ensureDirectory(dirAbs: string): Promise<void> {
	let s;
	try {
		s = await stat(dirAbs);
	} catch (error) {
		if (isFsIgnorable(error)) throw new Error(`Directory not found: ${dirAbs}`);
		throw error;
	}
	if (!s.isDirectory()) throw new Error(`Not a directory: ${dirAbs}`);
}

/* ------------------------------------------------------------------ */
/* Envelopes: success + error. execute() never throws.                 */
/* ------------------------------------------------------------------ */

interface ToolEnvelope {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	structuredContent: JsonValue;
	isError: boolean;
}

/** Local JSON-value alias (mirrors the host SDK's JsonValue structurally).
 * Keeps this file dependency-free while satisfying the host's
 * `structuredContent?: JsonValue` tool-result typing. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function successEnvelope(result: Record<string, unknown>): ToolEnvelope {
	return {
		content: [{ type: "text", text: JSON.stringify(result) }],
		details: result,
		structuredContent: result as JsonValue,
		isError: false,
	};
}

function errorEnvelope(mode: string, message: string): ToolEnvelope {
	const result = { ok: false, mode, error: message };
	return {
		content: [{ type: "text", text: JSON.stringify(result) }],
		details: result,
		structuredContent: result as JsonValue,
		isError: true,
	};
}

/* ------------------------------------------------------------------ */
/* Mode implementations (pure, reentrant).                             */
/* ------------------------------------------------------------------ */

async function doGlob(
	params: Extract<FileToolParams, { mode: "glob" }>,
	sessionCwd: string,
	signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
	const cwd = resolveBase(params.cwd, sessionCwd, ".");
	const limit = uncappedCount(params.maxResults, "maxResults");
	const includeHidden = params.includeHidden ?? true;
	const respectGitignore = params.respectGitignore ?? false;
	await ensureDirectory(cwd);
	if (checkAborted(signal)) return { ok: false, mode: "glob", error: "Aborted", aborted: true };
	const matchers = expandBraces(params.pattern).map((p) => globToRegExp(p));
	const ignoreRules = await loadIgnoreRules(cwd, respectGitignore);
	const nodes = await collectTree(cwd, {
		includeHidden,
		maxDepth: Number.POSITIVE_INFINITY,
		ignoreRules,
		skipGitDir: respectGitignore,
		includeDirs: true,
		includeFiles: true,
		signal,
	});
	const seen = new Set<string>();
	for (const node of nodes) {
		if (checkAborted(signal)) break;
		if (node.isBrokenLink) continue;
		const rel = node.relPath;
		const base = basename(rel);
		for (const matcher of matchers) {
			if (matcher.test(rel) || matcher.test(base)) {
				seen.add(rel);
				break;
			}
		}
	}
	const matched = [...seen].sort().slice(0, limit);
	return {
		ok: true,
		mode: "glob",
		pattern: params.pattern,
		cwd,
		files: matched,
		aborted: checkAborted(signal),
	};
}

interface LsEntry {
	name: string;
	path: string;
	type: "file" | "dir" | "symlink" | "other";
	size: number | null;
	mtime: string | null;
}

async function doLs(
	params: Extract<FileToolParams, { mode: "ls" }>,
	sessionCwd: string,
	signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
	const dirAbs = resolveBase(params.path, sessionCwd, ".");
	const long = params.long ?? false;
	const recursive = params.recursive ?? false;
	const limit = uncappedCount(params.maxResults, "maxResults");
	const depthLimit = params.maxDepth === undefined ? undefined : uncappedDepth(params.maxDepth, "maxDepth");
	const effectiveDepth = depthLimit ?? (recursive ? Number.POSITIVE_INFINITY : 1);
	const useFastPath = effectiveDepth === 1;
	await ensureDirectory(dirAbs);
	if (checkAborted(signal)) return { ok: false, mode: "ls", error: "Aborted", aborted: true };

	let nodes: TreeNode[];
	if (effectiveDepth < 1) {
		nodes = [];
	} else if (useFastPath) {
		let dirents;
		try {
			dirents = await readdir(dirAbs, { withFileTypes: true });
		} catch (error) {
			if (isFsIgnorable(error)) throw new Error(`Cannot read directory: ${dirAbs} (${messageOf(error)})`);
			throw error;
		}
		nodes = dirents.map((entry) => ({
			absPath: join(dirAbs, entry.name),
			relPath: entry.name,
			isDirectory: entry.isDirectory(),
			isBrokenLink: entry.isSymbolicLink(),
		}));
		nodes.sort((a, b) => a.relPath.localeCompare(b.relPath));
	} else {
		nodes = await collectTree(dirAbs, {
			includeHidden: true,
			maxDepth: effectiveDepth,
			ignoreRules: [],
			skipGitDir: false,
			includeDirs: true,
			includeFiles: true,
			signal,
		});
		nodes.sort((a, b) => a.relPath.localeCompare(b.relPath));
	}
	nodes = nodes.slice(0, limit);

	let entries: LsEntry[];
	if (!long) {
		// Dirent only — no stat calls.
		entries = nodes.map((node) => ({
			name: basename(node.absPath),
			path: node.absPath,
			type: node.isBrokenLink ? ("symlink" as const) : node.isDirectory ? ("dir" as const) : ("file" as const),
			size: null,
			mtime: null,
		}));
	} else {
		const stats = await mapSettled(nodes, CONCURRENCY, async (node) => {
			try {
				return await stat(node.absPath);
			} catch (error) {
				if (isFsIgnorable(error)) return undefined;
				throw error;
			}
		});
		entries = nodes.map((node, i) => {
			const s = stats[i];
			return {
				name: basename(node.absPath),
				path: node.absPath,
				type: node.isBrokenLink
					? ("symlink" as const)
					: node.isDirectory
						? ("dir" as const)
						: s?.isDirectory() === true
							? ("dir" as const)
							: ("file" as const),
				size: s ? s.size : null,
				mtime: s ? s.mtime.toISOString() : null,
			};
		});
	}

	return {
		ok: true,
		mode: "ls",
		path: dirAbs,
		entries,
		aborted: checkAborted(signal),
	};
}

interface FindEntry {
	path: string;
	type: "file" | "dir";
	size: number | null;
	mtime: string | null;
}

async function doFind(
	params: Extract<FileToolParams, { mode: "find" }>,
	sessionCwd: string,
	signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
	const root = resolveBase(params.root, sessionCwd, ".");
	const kind = params.type ?? "both";
	const depthLimit = params.maxDepth === undefined ? undefined : uncappedDepth(params.maxDepth, "maxDepth");
	const limit = uncappedCount(params.maxResults, "maxResults");
	const effectiveDepth = depthLimit ?? Number.POSITIVE_INFINITY;
	await ensureDirectory(root);
	if (checkAborted(signal)) return { ok: false, mode: "find", error: "Aborted", aborted: true };

	let afterMs: number | undefined;
	let beforeMs: number | undefined;
	if (params.modifiedAfter !== undefined) {
		afterMs = Date.parse(params.modifiedAfter);
		if (Number.isNaN(afterMs)) throw new Error(`Invalid modifiedAfter date: ${params.modifiedAfter}`);
	}
	if (params.modifiedBefore !== undefined) {
		beforeMs = Date.parse(params.modifiedBefore);
		if (Number.isNaN(beforeMs)) throw new Error(`Invalid modifiedBefore date: ${params.modifiedBefore}`);
	}
	const nameMatcher = params.namePattern !== undefined ? globToRegExp(params.namePattern) : undefined;
	const wantsFiles = kind === "file" || kind === "both";
	const wantsDirs = kind === "dir" || kind === "both";

	const nodes = (
		await collectTree(root, {
			includeHidden: true,
			maxDepth: effectiveDepth,
			ignoreRules: [],
			skipGitDir: false,
			includeDirs: wantsDirs,
			includeFiles: wantsFiles,
			signal,
		})
	).filter((node) => {
		if (node.isBrokenLink) return false;
		if (node.isDirectory && !wantsDirs) return false;
		if (!node.isDirectory && !wantsFiles) return false;
		if (nameMatcher !== undefined) {
			const base = basename(node.absPath);
			if (!nameMatcher.test(base) && !nameMatcher.test(node.relPath)) return false;
		}
		return true;
	});

	const stats = await mapSettled(nodes, CONCURRENCY, async (node) => {
		try {
			return await stat(node.absPath);
		} catch (error) {
			if (isFsIgnorable(error)) return undefined;
			throw error;
		}
	});

	const entries: FindEntry[] = [];
	for (let i = 0; i < nodes.length; i += 1) {
		if (checkAborted(signal)) break;
		const node = nodes[i];
		const s = stats[i];
		if (s === undefined) continue; // vanished or unreadable mid-walk
		if (params.minSize !== undefined || params.maxSize !== undefined) {
			if (node.isDirectory) continue; // size filters apply to files only
			if (params.minSize !== undefined && s.size < params.minSize) continue;
			if (params.maxSize !== undefined && s.size > params.maxSize) continue;
		}
		const mtimeMs = s.mtimeMs;
		if (afterMs !== undefined && !(mtimeMs > afterMs)) continue;
		if (beforeMs !== undefined && !(mtimeMs < beforeMs)) continue;
		entries.push({
			path: node.absPath,
			type: node.isDirectory ? "dir" : "file",
			size: s.size,
			mtime: s.mtime.toISOString(),
		});
	}
	entries.sort((a, b) => a.path.localeCompare(b.path));
	const limited = entries.slice(0, limit);
	return {
		ok: true,
		mode: "find",
		root,
		entries: limited,
		aborted: checkAborted(signal),
	};
}

interface GrepMatch {
	file: string;
	line: number;
	column: number;
	text: string;
	contextBefore: string[];
	contextAfter: string[];
}

async function doGrep(
	params: Extract<FileToolParams, { mode: "grep" }>,
	sessionCwd: string,
	signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
	const root = resolveBase(params.root, sessionCwd, ".");
	const useRegex = params.regex ?? false;
	const caseSensitive = params.caseSensitive ?? true;
	const matchLimit = uncappedCount(params.maxMatches, "maxMatches");
	const fileSizeLimit = uncappedCount(params.maxFileSize, "maxFileSize");
	const beforeLines = uncappedContext(params.beforeContext, "beforeContext");
	const afterLines = uncappedContext(params.afterContext, "afterContext");
	await ensureDirectory(root);
	if (checkAborted(signal)) return { ok: false, mode: "grep", error: "Aborted", aborted: true };

	let lineRegex: RegExp | undefined;
	if (useRegex) {
		try {
			lineRegex = new RegExp(params.pattern, caseSensitive ? "" : "i");
		} catch {
			throw new Error(`Invalid regex pattern: ${params.pattern}`);
		}
	}
	const needle = useRegex ? "" : caseSensitive ? params.pattern : params.pattern.toLowerCase();
	if (!useRegex && needle.length === 0) throw new Error("Grep pattern must not be empty");

	const includeMatcher = params.include !== undefined ? globToRegExp(params.include) : undefined;
	const nodes = await collectTree(root, {
		includeHidden: true,
		maxDepth: Number.POSITIVE_INFINITY,
		ignoreRules: [],
		skipGitDir: true, // .git objects are compressed binaries; never useful hits
		includeDirs: false,
		includeFiles: true,
		signal,
	});
	const candidates = nodes.filter((node) => {
		if (node.isBrokenLink) return false;
		if (includeMatcher === undefined) return true;
		const base = basename(node.absPath);
		return includeMatcher.test(base) || includeMatcher.test(node.relPath);
	});

	const matches: GrepMatch[] = [];
	let filesSearched = 0;
	let skippedBinary = 0;
	let skippedUnreadable = 0;

	for (let i = 0; i < candidates.length && matches.length < matchLimit; i += CONCURRENCY) {
		if (checkAborted(signal)) break;
		const chunk = candidates.slice(i, i + CONCURRENCY);
		const settled = await Promise.allSettled(
			chunk.map(async (node) => {
				let s;
				try {
					s = await stat(node.absPath);
				} catch (error) {
					if (isFsIgnorable(error)) return { status: "unreadable" as const };
					throw error;
				}
				if (!s.isFile()) return { status: "unreadable" as const };
				if (s.size > fileSizeLimit) return { status: "skipped" as const };
				let buf: Buffer;
				try {
					buf = await readFile(node.absPath);
				} catch (error) {
					if (isFsIgnorable(error)) return { status: "unreadable" as const };
					throw error;
				}
				if (isBinaryBuffer(buf)) return { status: "binary" as const };
				return { status: "ok" as const, text: buf.toString("utf8"), file: node.absPath };
			}),
		);
		for (const result of settled) {
			if (result.status !== "fulfilled") {
				skippedUnreadable += 1;
				continue;
			}
			const value = result.value;
			if (value.status === "binary") {
				skippedBinary += 1;
				continue;
			}
			if (value.status === "unreadable") {
				skippedUnreadable += 1;
				continue;
			}
			if (value.status === "skipped") {
				continue;
			}
			filesSearched += 1;
			const lines = value.text.split("\n");
			for (let lineIdx = 0; lineIdx < lines.length && matches.length < matchLimit; lineIdx += 1) {
				const line = lines[lineIdx].replace(/\r$/, "");
				let column = -1;
				if (lineRegex !== undefined) {
					lineRegex.lastIndex = 0;
					const m = lineRegex.exec(line);
					if (m !== null) column = (m.index ?? 0) + 1;
				} else {
					const hay = caseSensitive ? line : line.toLowerCase();
					const at = hay.indexOf(needle);
					if (at !== -1) column = at + 1;
				}
				if (column === -1) continue;
				const isKeyFile = KEY_FILE_RE.test(value.file);
				matches.push({
					file: value.file,
					line: lineIdx + 1,
					column,
					text: redactMatchLine(line, isKeyFile),
					contextBefore: lines
						.slice(Math.max(0, lineIdx - beforeLines), lineIdx)
						.map((l) => redactMatchLine(l.replace(/\r$/, ""), isKeyFile)),
					contextAfter: lines
						.slice(lineIdx + 1, lineIdx + 1 + afterLines)
						.map((l) => redactMatchLine(l.replace(/\r$/, ""), isKeyFile)),
				});
			}
		}
	}

	return {
		ok: true,
		mode: "grep",
		pattern: params.pattern,
		root,
		matches: matches.slice(0, matchLimit),
		filesSearched,
		skipped: { binary: skippedBinary, unreadable: skippedUnreadable },
		aborted: checkAborted(signal),
	};
}

/* ------------------------------------------------------------------ */
/* Bash steering: block bare shell discovery, allow real shell work.   */
/* ------------------------------------------------------------------ */

const TOOLING_RE = /\b(npm|yarn|pnpm|bun|deno|cargo|go|dotnet|make|cmake|gradle|pytest|jest|vitest|mocha|tsc|eslint|git|docker|kubectl|ssh|scp|curl|wget|python|node)\b/;
const COMPOUND_RE = /[|;&>`]/;
const SUBST_RE = /\$\(/;

function steeringForBash(command: string): string | undefined {
	const cmd = command.trim();
	if (cmd.length === 0) return undefined;
	// Allow compound shell work: pipes, chains, redirects, substitutions.
	if (COMPOUND_RE.test(cmd) || SUBST_RE.test(cmd)) return undefined;
	// Allow build/test/git/tooling invocations even if they mention names.
	if (TOOLING_RE.test(cmd)) return undefined;
	// Inspect only argv[0]: strip env assignments, sudo, and
	// command/builtin/env wrappers plus any path prefix (/bin/ls -> ls).
	// Loop until stable so combinations like `sudo FOO=bar command ls` resolve.
	let bare = cmd;
	let prev = "";
	while (bare !== prev) {
		prev = bare;
		bare = bare.replace(/^sudo\s+/, "");
		bare = bare.replace(/^(command|builtin|env)\s+/, "");
		bare = bare.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/, "");
	}
	const first = bare.split(/\s+/, 1)[0] ?? "";
	// basename strips path prefixes: /bin/ls -> ls, /usr/bin/grep -> grep.
	const prog = basename(first);

	if (prog === "ls" || prog === "dir") {
		const recursive = /(^|\s)-[a-zA-Z]*R/.test(bare);
		return (
			`Use file-search-tool(mode="ls", path="<dir>"${recursive ? ", recursive=true" : ""}) instead of \`${prog}\` ` +
			`for directory listing (structured JSON, no shell spam).`
		);
	}
	if (prog === "find") {
		return 'Use file-search-tool(mode="find", root="<dir>", namePattern="<glob>") instead of `find` (single walk, inline filters).';
	}
	if (prog === "grep" || prog === "rg" || prog === "ag") {
		return 'Use file-search-tool(mode="grep", pattern="<text>", root="<dir>") instead of `grep`/`rg`/`ag` (full unbounded structured results, redacted; output may be very large).';
	}
	if (prog === "glob") {
		return 'Use file-search-tool(mode="glob", pattern="<glob>", cwd="<dir>") instead of shell globbing.';
	}
	// cat-style discovery: wildcard dumps are exploration, not reading.
	if (prog === "cat" && /[*?[{]/.test(bare)) {
		return 'Use file-search-tool(mode="grep", pattern="<text>", root="<dir>") or file-search-tool(mode="ls") instead of wildcard `cat` for discovery.';
	}
	return undefined;
}

/* ------------------------------------------------------------------ */
/* Extension factory (sync only: no top-level await, timers, sockets). */
/* ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "file-search-tool",
		label: "File Search Tool",
		description:
			"Fast local filesystem discovery (glob, ls, find, grep) with structured JSON output. " +
			"Use mode='glob' to match path patterns, mode='ls' to list a directory (recursive=true to walk), " +
			"mode='find' to filter entries by name/size/mtime, mode='grep' to search file contents. " +
			"Prefer this over bash ls/find/grep/rg/ag for exploration. " +
			"Returns full unbounded results; output may be very large. Limits such as maxResults/maxMatches/maxFileSize are unbounded (omit for all); negative values including -1 are invalid. Secrets are masked in output.",
		parameters: FileToolParameters,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			void toolCallId;
			try {
				const p = params as FileToolParams;
				const sessionCwd = ctx.cwd ?? process.cwd();
				switch (p.mode) {
					case "glob":
						return successEnvelope(await doGlob(p, sessionCwd, signal));
					case "ls":
						return successEnvelope(await doLs(p, sessionCwd, signal));
					case "find":
						return successEnvelope(await doFind(p, sessionCwd, signal));
					case "grep":
						return successEnvelope(await doGrep(p, sessionCwd, signal));
					default:
						return errorEnvelope("unknown", `Unknown file-search-tool mode: ${JSON.stringify((p as { mode?: unknown }).mode)}`);
				}
			} catch (error) {
				return errorEnvelope("unknown", messageOf(error));
			}
		},
	});

	pi.on("tool_call", async (event, _ctx) => {
		if (!isToolCallEventType("bash", event)) return undefined;
		const raw = (event.input as { command?: unknown }).command;
		if (typeof raw !== "string") return undefined;
		const reason = steeringForBash(raw);
		if (reason !== undefined) return { block: true, reason };
		return undefined;
	});

	// No session-scoped resources are ever opened, so shutdown is a no-op.
	pi.on("session_shutdown", async () => {});
}
