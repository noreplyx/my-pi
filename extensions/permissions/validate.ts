/**
 * Startup validation for permission configs.
 *
 * Pure functions (no fs, no pi) so they can be unit-tested directly.
 * Enforcement never depends on this module — it only *reports* problems.
 * Broken regexes fail closed at runtime in loader.ts (deny blocks,
 * allow/ask never matches); these diagnostics make that visible at startup
 * instead of mid-run.
 */

import { globToRegExp, hasGlobChars, isRegexPattern } from "./matcher.ts";
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

/** One config file to validate: the global file or a single agent file. */
export interface FileReport {
	/** Display path, e.g. `permissions.json` or `agents/deployer.md`. */
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

/** Validate the rules of one file. `knownTools` = pi.getAllTools() names; empty = skip R2. */
function validateRules(
	label: string,
	validated: ValidatedConfig,
	knownTools: string[],
	isAgent: boolean,
): Diagnostic[] {
	const diags: Diagnostic[] = [];
	const rules = validated.config.rules;

	// Surface schema errors (bad action / bad match type / bad tool).
	for (const e of validated.errors) {
		diags.push({ severity: "error", location: label, message: e });
	}

	rules.forEach((r, i) => {
		const loc = `${label} rules[${i}]`;

		// R1: regex that never compiles. Runtime fails closed (deny blocks,
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
			}
		}

		// R2: tool matches no known tool (likely typo). Warning only — MCP/custom
		// tools may connect after startup, so this can be a false positive.
		if (knownTools.length > 0) {
			const toolMayBeRegex = isRegexPattern(r.tool) !== null;
			const matchesKnown =
				toolMayBeRegex ||
				knownTools.some((t) => {
					if (!hasGlobChars(r.tool)) return r.tool === t;
					try {
						return globToRegExp(r.tool).test(t);
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

		// R3: unreachable — an earlier rule already covers everything this one can match.
		// Cheap, exact cases only: earlier match-all with same-or-wider tool, or identical match.
		// Plain first-match order applies within each file (agent-first globally).
		for (let k = 0; k < i; k++) {
			const prev = rules[k];
			const sameTool = prev.tool === r.tool || prev.tool === "*";
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
			(r.tool === "bash" || r.tool === "powershell") &&
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

		// R4: overly broad allow.
		if (r.action === "allow") {
			if (r.tool === "*" && r.match === undefined) {
				diags.push({
					severity: "warning",
					location: loc,
					message: `allows every tool call — global allow-all`,
					hint: `scope it to specific tools`,
				});
			} else if ((r.tool === "bash" || r.tool === "powershell") && r.match === undefined) {
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

/** Validate the global file + all agent files. Never throws. Agent rules beat
 *  global rules (including global deny), so no cross-file shadowing applies. */
export function collectDiagnostics(files: FileReport[], knownTools: string[]): Diagnostic[] {
	const diags: Diagnostic[] = [];
	try {
		for (const f of files) {
			if (!f.exists) {
				if (!f.isAgent) {
					// G1: no global policy file — enforcement falls back to ask-everything.
					diags.push({
						severity: "info",
						location: f.label,
						message: `no global policy file — default action "ask" applies to every tool call`,
						hint: `create ${f.label} to set a policy`,
					});
				}
				continue;
			}
			diags.push(...validateRules(f.label, f.validated, knownTools, f.isAgent));
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
