/**
 * Startup validation for permission configs.
 *
 * Pure functions (no fs, no pi) so they can be unit-tested directly.
 * Enforcement never depends on this module — it only *reports* problems.
 * Broken regexes and broken globs fail closed at runtime in loader.ts
 * (deny blocks, allow/ask never matches); these diagnostics make that
 * visible at startup instead of mid-run.
 */
import { globToRegExp, hasGlobChars, hasInvalidGlob, isRegexPattern } from "./matcher.ts";
import { splitShellCommands } from "./shell-split.ts";
import type { ValidatedConfig } from "./schema.ts";

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
	severity: DiagnosticSeverity;
	location: string;
	message: string;
	hint?: string;
	/** Machine-readable identity for lifecycle handling (e.g. retracting
	 *  unknown-tool warnings once the tool is observed in a tool call). */
	tag?: { kind: "unknown-tool"; pattern: string };
}

/** One config file to validate: a single agent file (incl. agents/main.md). */
export interface FileReport {
	/** Display path, e.g. `agents/deployer.md`. */
	label: string;
	exists: boolean;
	validated: ValidatedConfig;
	isAgent: boolean;
}

function compiles(pattern: string): boolean {
	const rx = isRegexPattern(pattern);
	if (!rx) return true; // not a regex — nothing to compile
	try {
		new RegExp(rx.body, rx.flags);
		return true;
	} catch {
		return false;
	}
}

/** Basename of a display path (both `/` and `\\` separators). Case-sensitive. */
export function baseNameOf(p: string): string {
	const s = p.split("/").pop() ?? p;
	return s.split("\\").pop() ?? s;
}

/** True when a FileReport label identifies the active agent file.
 *
 * Tolerant path forms (case-sensitive name): exact match after trim,
 * basename match (`reviewer.md` vs `agents/reviewer.md` vs absolute
 * path), or suffix match with a `/` separator guard
 * (`agents/reviewer.md` matches `/proj/agents/reviewer.md` but
 * `agents/reviewer.md` does NOT match `/xagents/reviewer.md`).
 * This keeps R2 enabled across absolute-path / different cwd-relative
 * label forms instead of silently disabling it on mismatch. */
export function isActiveAgentFile(label: string, activeFileLabel: string | null | undefined): boolean {
	const l = label?.trim() ?? "";
	const a = activeFileLabel?.trim() ?? "";
	if (!l || !a) return false;
	if (l === a) return true;
	if (baseNameOf(l) === baseNameOf(a)) return true;
	// Defense-in-depth: subsumed by basename above (equal basenames already
	// returned), kept so a future basename change cannot silently widen this.
	if (l.endsWith(`/${a}`) || a.endsWith(`/${l}`)) return true;
	return false;
}

/** Options for scoping startup validation. R2 (unknown-tool) can be
 *  scoped to the active agent only; all other rules always run globally. */
export interface ValidateOptions {
	/** Label of the active agent file. Tolerant match via {@link isActiveAgentFile}
	 *  (exact, basename, or `/`-guarded suffix) — callers should pass a
	 *  `FileReport.label` (or any path form of it, e.g. absolute path).
	 *  Null = unknown. Normalized (`trim()`) at entry. */
	activeFileLabel?: string | null;
	/** When true, run the R2 unknown-tool block only for the active file (skip entirely when null). */
	scopeUnknownToolCheckToActive?: boolean;
	/** @deprecated Use `activeFileLabel` instead. Kept for compatibility. */
	activeLabel?: string | null;
	/** @deprecated Use `scopeUnknownToolCheckToActive` instead. Kept for compatibility. */
	scopeR2ToActive?: boolean;
}

/** Validate the rules of one file. `knownTools` = pi.getAllTools() names; empty = skip R2. */
function validateRules(
	label: string,
	validated: ValidatedConfig,
	knownTools: string[],
	isAgent: boolean,
	opts?: ValidateOptions,
): Diagnostic[] {
	const diags: Diagnostic[] = [];
	const rules = validated.config.rules;
	// Per-file R2 scope (hoisted: identical for every rule in this file).
	const r2ScopingEnabled = opts?.scopeUnknownToolCheckToActive ?? opts?.scopeR2ToActive ?? false;
	const activeAgentLabel = opts?.activeFileLabel?.trim() || opts?.activeLabel?.trim() || null;
	const unknownToolCheckInScope = !r2ScopingEnabled ? true : activeAgentLabel ? isActiveAgentFile(label, activeAgentLabel) : false;

	// Surface schema errors (bad action / bad match type / bad tool).
	for (const e of validated.errors) {
		diags.push({ severity: "error", location: label, message: e });
	}

	rules.forEach((r, i) => {
		const loc = `${label} rules[${i}]`;
		// Tool names match case-insensitively at runtime (see matchToolName),
		// so all tool-name comparisons here use the lowered form.
		const toolLower = r.tool.toLowerCase();

		// R1/R1b: regex or glob that never compiles. Runtime fails closed (deny blocks,
		// allow/ask never matches) — this diagnostic is the visibility path.
		const patterns = r.match === undefined ? [] : Array.isArray(r.match) ? r.match : [r.match];
		for (const p of patterns) {
			if (typeof p !== "string") continue;
			if (isRegexPattern(p) && !compiles(p)) {
				diags.push({
					severity: "error",
					location: loc,
					message: `invalid regex ${JSON.stringify(p)} — deny fails closed (blocks), allow/ask never matches`,
					hint: `fix the pattern or use a glob/substring instead`,
				});
			} else if (isRegexPattern(p.trim()) === null && hasInvalidGlob(p)) {
				diags.push({
					severity: "error",
					location: loc,
					message: `invalid glob ${JSON.stringify(p)} — deny fails closed (blocks), allow/ask never matches`,
					hint: `fix the character class or escape the brackets`,
				});
			}
		}

		// R2: tool matches no known tool (likely typo). Warning only — MCP/custom
		// tools may connect after startup, so this can be a false positive.
		// Scoped to the active agent only (R2 scopeUnknownToolCheckToActive + activeFileLabel,
		// other agents' files skip R2, so a minimal session never flags tools
		// that simply are not registered here. Case-insensitive, glob-aware,
		// as at runtime. Enforcement is unaffected — this is reporting only.
		if (knownTools.length > 0) {
			if (unknownToolCheckInScope) {
				const toolMayBeRegex = isRegexPattern(r.tool) !== null;
				const matchesKnown =
					toolMayBeRegex ||
					knownTools.some((t) => {
						if (!hasGlobChars(r.tool)) return toolLower === t.toLowerCase();
						try {
							return globToRegExp(toolLower).test(t.toLowerCase());
						} catch {
							return false;
						}
					});
				if (!matchesKnown) {
					diags.push({
						severity: "warning",
						location: loc,
						message: `tool ${JSON.stringify(r.tool)} matches no known tool (yet?) — typo, or a tool that connects later`,
						hint: `check the spelling; ignore this if the tool connects after startup (MCP/custom tools)`,
						tag: { kind: "unknown-tool", pattern: r.tool },
					});
				}
			}
		}

		// R3: unreachable — an earlier rule already covers everything this one can match.
		// Cheap, exact cases only: earlier match-all with same-or-wider tool, or identical match.
		// Plain first-match order applies within each agent file.
		for (let k = 0; k < i; k++) {
			const prev = rules[k];
			const sameTool = prev.tool.toLowerCase() === toolLower || prev.tool === "*";
			if (!sameTool) continue;
			const prevAll = prev.match === undefined;
			const sameMatch = JSON.stringify(prev.match ?? null) === JSON.stringify(r.match ?? null);
			if (!prevAll && !sameMatch) continue;
			diags.push({
				severity: "warning",
				location: loc,
				message: `unreachable: rules[${k}] already matches everything this rule can match`,
				hint: `remove it or move it above rules[${k}]`,
			});
			break;
		}

		// R6: prefix-anchored shell allow without an end anchor or chaining guard.
		// Chain splitting evaluates each `; && || | &` segment independently
		// (strict: every segment must allow), so a prefix allow is safer than
		// it used to be — but a metachar deny stays recommended
		// defense-in-depth (redirects/subshells stay inside their segment).
		if (
			r.action === "allow" &&
			(toolLower === "bash" || toolLower === "powershell") &&
			patterns.some((p) => {
				if (typeof p !== "string") return false;
				const rx = isRegexPattern(p);
				if (!rx) return false;
				return rx.body.startsWith("^") && !rx.body.endsWith("$");
			})
		) {
			diags.push({
				severity: "warning",
				location: loc,
				message: `prefix-anchored shell allow matches chained commands (e.g. "git status; evil") — chain splitting evaluates each segment (strict: all must allow), a metachar deny stays recommended defense-in-depth`,
				hint: `precede it with a deny on shell metachars (;, &&, ||, |, $(), backticks) or anchor with $, or rely on per-segment evaluation with strict all-allow`,
			});
		}

		// R7: chained shell command in allow/ask match. Per-agent permissions
		// must be single-command only — split chained matches into separate rules.
		// Regex patterns are skipped (`|` is alternation, `;` may sit inside a
		// character class/guard like `[^;&|$...]`). Deny is exempt: metachar
		// denies such as `re:[;&|$...]` intentionally contain chaining chars.
		if (
			(r.action === "allow" || r.action === "ask") &&
			(toolLower === "bash" || toolLower === "powershell")
		) {
			for (const p of patterns) {
				if (typeof p !== "string") continue;
				if (isRegexPattern(p) !== null) continue;
				const segments = splitShellCommands(p);
				if (segments.length > 1) {
					diags.push({
						severity: "error",
						location: loc,
						message: `chained shell command in permission match splits into ${segments.length} segments — per-agent permissions must be single-command only`,
						hint: `split into ${segments.length} separate rules (one per command)`,
					});
					break;
				}
			}
		}

		// R4: overly broad allow.
		if (r.action === "allow") {
			if (r.tool === "*" && r.match === undefined) {
				diags.push({
					severity: "warning",
					location: loc,
					message: `allows every tool call — allow-all`,
					hint: `scope it to specific tools`,
				});
			} else if ((toolLower === "bash" || toolLower === "powershell") && r.match === undefined) {
				diags.push({
					severity: "warning",
					location: loc,
					message: `allows all ${r.tool} commands without prompting`,
					hint: `add a match to scope it, e.g. { match: "re:^git\\\\s+(status|diff)\\\\b" }`,
				});
			}
		}
	});

	if (isAgent) {
		// A2: permissions block with no effect.
		if (rules.length === 0 && !validated.hasDefault) {
			diags.push({
				severity: "warning",
				location: label,
				message: `permissions block has no rules and no defaultAction — no effect`,
				hint: `add rules or remove the block`,
			});
		}
		// A3: default-allow with no rules (allows everything).
		if (rules.length === 0 && validated.hasDefault && validated.config.defaultAction === "allow") {
			diags.push({
				severity: "warning",
				location: label,
				message: `defaultAction "allow" with no rules allows everything`,
				hint: `use "ask" or add scoping rules`,
			});
		}
	}

	return diags;
}

/** Validate all agent files (agent-only — no global layer, no cross-file
 *  shadowing). Never throws.
 *
 *  `knownTools` is the dynamic session tool list (pi.getAllTools()); the R2
 *  unknown-tool check runs only for the active agent when
 *  `opts.scopeUnknownToolCheckToActive` is true (skipped entirely when the
 *  normalized `activeFileLabel` is null); all other rules (R1/R3-R7) always
 *  run globally. Active-file matching is tolerant (see {@link isActiveAgentFile}:
 *  exact, basename, or `/`-guarded suffix — so absolute-path or different
 *  cwd-relative forms still match instead of silently disabling R2).
 *  Empty `knownTools` still skips the R2 check entirely. */
export function collectDiagnostics(files: FileReport[], knownTools: string[], opts?: ValidateOptions): Diagnostic[] {
	const diags: Diagnostic[] = [];
	try {
		for (const f of files) {
			if (!f.exists) {
				// Missing agent policy file (e.g. agents/main.md) —
				// enforcement falls back to ask-everything for that agent.
				diags.push({
					severity: "warning",
					location: f.label,
					message: `no agent policy file — default action "ask" applies to every tool call`,
					hint: `create ${f.label} with a permissions: block to set a policy`,
				});
				continue;
			}
			diags.push(...validateRules(f.label, f.validated, knownTools, f.isAgent, opts));
		}
	} catch (e: any) {
		diags.push({ severity: "error", location: "permissions", message: `validator failed: ${e?.message ?? e}` });
	}
	const rank = { error: 0, warning: 1, info: 2 } as const;
	return diags.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

const MAX_STARTUP_LINES = 8;

/** One compact block for notify/console. Empty string = clean, say nothing. */
export function formatStartupReport(diags: Diagnostic[]): string {
	if (diags.length === 0) return "";
	const errors = diags.filter((d) => d.severity === "error").length;
	const warnings = diags.filter((d) => d.severity === "warning").length;
	const infos = diags.filter((d) => d.severity === "info").length;
	const parts = [
		`${errors} error${errors === 1 ? "" : "s"}`,
		`${warnings} warning${warnings === 1 ? "" : "s"}`,
		...(errors === 0 && warnings === 0 ? [`${infos} note${infos === 1 ? "" : "s"}`] : []),
	];
	const lines = [`Permissions: ${parts.join(", ")}`];
	for (const d of diags.slice(0, MAX_STARTUP_LINES)) {
		lines.push(`  ${d.severity}  ${d.location}: ${d.message}`);
	}
	if (diags.length > MAX_STARTUP_LINES) {
		lines.push(`  …and ${diags.length - MAX_STARTUP_LINES} more — run /permissions-status for details`);
	} else {
		lines.push(`Run /permissions-status for details.`);
	}
	return lines.join("\n");
}
