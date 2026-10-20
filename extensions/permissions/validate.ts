/**
 * Startup validation for permission configs.
 *
 * Pure functions (no fs, no pi) so they can be unit-tested directly.
 * Enforcement never depends on this module — it only *reports* problems.
 * Broken regexes fail closed at runtime in loader.ts (deny blocks,
 * allow/ask never matches); these diagnostics make that visible at startup
 * instead of mid-run.
 */

import { globToRegExp, hasGlobChars, isRegexPattern, matchToolName } from "./matcher.ts";
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
		// In the global file, deny rules run in the floor scan before any allow/ask,
		// so an earlier allow/ask can never shadow a later deny — only an earlier deny can.
		for (let k = 0; k < i; k++) {
			const prev = rules[k];
			const sameTool = prev.tool === r.tool || prev.tool === "*";
			if (!sameTool) continue;
			const prevAll = prev.match === undefined;
			const sameMatch = JSON.stringify(prev.match ?? null) === JSON.stringify(r.match ?? null);
			if (!prevAll && !sameMatch) continue;
			if (!isAgent && r.action === "deny" && prev.action !== "deny") continue;
			diags.push({
				severity: "warning",
				location: loc,
				message: `unreachable: rules[${k}] already matches everything this rule can match`,
				hint: `remove it or move it above rules[${k}]`,
			});
			break;
		}

		// R6: prefix-anchored shell allow without an end anchor or chaining guard.
		// `re:^git...` matches `git status; evil` — pair with a metachar deny.
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
				message: `prefix-anchored shell allow matches chained commands (e.g. "git status; evil")`,
				hint: `precede it with a deny on shell metachars (;, &&, ||, |, $(), backticks) or anchor with $`,
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
		// A3: default-allow with no rules (allows everything except the global deny floor).
		if (rules.length === 0 && validated.hasDefault && validated.config.defaultAction === "allow") {
			diags.push({
				severity: "warning",
				location: label,
				message: `defaultAction "allow" with no rules allows everything (except global deny rules)`,
				hint: `use "ask" or add scoping rules`,
			});
		}
	}

	return diags;
}

/** An agent allow/ask rule is dead on arrival when a global deny floor rule
 *  matches everything it can match. Conservative, exact cases only:
 *  same tool string (or global `*`, or a global glob covering an exact agent
 *  tool) plus global match-all or byte-identical match. */
function killedByFloor(agentRule: { tool: string; match?: string | string[] }, globalDenies: { tool: string; match?: string | string[] }[]): string | null {
	for (const g of globalDenies) {
		const toolCovered =
			g.tool === "*" ||
			g.tool === agentRule.tool ||
			(!hasGlobChars(agentRule.tool) && hasGlobChars(g.tool) && matchToolName(g.tool, agentRule.tool));
		if (!toolCovered) continue;
		const matchCovered = g.match === undefined || JSON.stringify(g.match ?? null) === JSON.stringify(agentRule.match ?? null);
		if (!matchCovered) continue;
		return `tool="${g.tool}" match=${JSON.stringify(g.match ?? "(any)")}`;
	}
	return null;
}

/** Validate the global file + all agent files. Never throws. */
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
		// R5: agent allow/ask rules the global deny floor always overrides.
		const globalDenies = files
			.filter((f) => !f.isAgent && f.exists)
			.flatMap((f) => f.validated.config.rules.filter((r) => r.action === "deny"));
		if (globalDenies.length > 0) {
			for (const f of files) {
				if (!f.isAgent || !f.exists) continue;
			f.validated.config.rules.forEach((r, i) => {
					if (r.action === "deny") return; // deny-vs-deny is redundant, not misleading
					const killer = killedByFloor(r, globalDenies);
					if (killer) {
						diags.push({
							severity: "warning",
							location: `${f.label} rules[${i}]`,
							message: `never takes effect — global deny floor (${killer}) always matches first`,
							hint: `a global deny cannot be loosened; narrow this rule to calls outside the floor or remove it`,
						});
					}
				});
			}
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
