/**
 * Permission enforcement extension.
 *
 * Global config:  ~/.pi/agent/permissions.json
 * Per-agent:      `permissions:` in agents/*.md frontmatter (wins over global,
 *                 except it can never loosen a global deny)
 *
 * Rule shape: { tool, match?, action } — `match` is a single string (or
 * string[] = OR): glob, `re:<regex>`, `/regex/flags`, or plain substring.
 * Evaluated against the tool's primary target (bash → command, fs tools →
 * path, others → JSON args).
 *
 * Broken patterns fail closed: an uncompilable regex in a `deny` rule is
 * treated as matching (blocks), in an `allow`/`ask` rule as never matching
 * (falls through). See loader.ts.
 */

import * as path from "node:path";
import { getAgentDir, withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildTargets, describeStatus, evaluate, getGlobalPermissionsPath, loadAllAgentFiles, loadGlobal, reloadAll } from "./loader.ts";
import { matchToolName } from "./matcher.ts";
import { collectDiagnostics, formatStartupReport, type Diagnostic, type FileReport } from "./validate.ts";

function auditPath(): string {
	return path.join(getAgentDir(), "permissions", "audit.log");
}

async function audit(action: string, toolName: string, target: string, extra = ""): Promise<void> {
	const line = `[${new Date().toISOString()}] agent=${process.env.PI_AGENT_NAME ?? "-"} ${action.toUpperCase()} tool=${toolName} target=${JSON.stringify(target.slice(0, 500))}${extra ? ` ${extra}` : ""}\n`;
	try {
		await withFileMutationQueue(auditPath(), async () => {
			const { appendFile, mkdir } = await import("node:fs/promises");
			await mkdir(path.dirname(auditPath()), { recursive: true });
			await appendFile(auditPath(), line);
		});
	} catch {
		// never break tool execution on audit failure
	}
}

function preview(s: string, max = 300): string {
	const oneLine = s.replace(/\s+/g, " ").trim() || "(no args)";
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Gather global + all agent configs for validation. Never throws. */
function gatherFileReports(cwd: string): FileReport[] {
	const reports: FileReport[] = [];
	try {
		const g = loadGlobal();
		reports.push({ label: g.filePath, exists: g.exists, validated: g.validated, isAgent: false });
	} catch (e: any) {
		reports.push({
			label: getGlobalPermissionsPath(),
			exists: false,
			validated: { config: { defaultAction: "ask", rules: [] }, errors: [`${e?.message ?? e}`], hasDefault: false },
			isAgent: false,
		});
	}
	try {
		for (const a of loadAllAgentFiles(cwd)) {
			reports.push({ label: a.label, exists: true, validated: a.validated, isAgent: true });
		}
	} catch (e: any) {
		reports.push({
			label: "agents/",
			exists: false,
			validated: { config: { defaultAction: "ask", rules: [] }, errors: [`agent scan failed: ${e?.message ?? e}`], hasDefault: false },
			isAgent: true,
		});
	}
	return reports;
}

export default function (pi: ExtensionAPI) {
	function knownToolNames(): string[] {
		try {
			return pi.getAllTools().map((t) => t.name);
		} catch {
			return []; // R2 check is skipped when the tool list is unavailable
		}
	}

	// Tools observed in real calls. Unknown-tool warnings (R2) are provisional —
	// MCP/custom tools can register after startup — so a warning retracts as soon
	// as its pattern matches an actually-invoked tool. Bounded: tool names are few
	// (plus a hard cap for pathological cases).
	const seenTools = new Set<string>();
	function withoutRetracted(diags: Diagnostic[]): Diagnostic[] {
		if (seenTools.size === 0) return diags;
		return diags.filter((d) => {
			if (d.tag?.kind !== "unknown-tool") return true;
			for (const t of seenTools) {
				try {
					if (matchToolName(d.tag.pattern, t)) return false;
				} catch {
					// ignore a bad pattern here — R1 already reported it
				}
			}
			return true;
		});
	}

	// Startup validation: warn about broken/suspicious permission configs.
	// Startup/reload only (not resume/fork/new) to avoid repeat noise.
	// Never blocks startup — broken rules are already fail-closed at enforcement.
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup" && event.reason !== "reload") return;
		try {
			reloadAll();
			const diags = withoutRetracted(collectDiagnostics(gatherFileReports(ctx.cwd), knownToolNames()));
			if (diags.length === 0) return;
			const text = formatStartupReport(diags);
			const level = diags.some((d) => d.severity === "error") ? "error" : "warning";
			if (ctx.hasUI) ctx.ui.notify(text, level);
			else console.warn(text); // stderr only — never stdout (would corrupt --mode json)
		} catch {
			// validation must never break startup
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (seenTools.size < 1000) seenTools.add(event.toolName);
		const input = (event.input ?? {}) as Record<string, unknown>;
		const result = evaluate(event.toolName, input, ctx.cwd);

		if (result.action === "allow") return undefined;

		const where =
			result.source === "agent"
				? `agent rule #${result.ruleIndex + 1}`
				: result.source === "global"
					? `global rule #${result.ruleIndex + 1}`
					: `default (${result.source})`;
		const label = `${event.toolName} ${preview(result.target)}`.trim();

		if (result.action === "deny") {
			void audit("deny", event.toolName, result.target, `via=${where}`);
			return { block: true, reason: `Blocked by permissions (${where}): ${label}` };
		}

		// action === "ask"
		if (!ctx.hasUI) {
			void audit("deny", event.toolName, result.target, `via=${where} ask-without-ui`);
			return { block: true, reason: `Blocked by permissions (${where}, no UI to confirm): ${label}` };
		}
		const ok = await ctx.ui.confirm(
			"Allow tool call?",
			`${label}\n\nMatched ${where}${result.rule ? ` — tool="${result.rule.tool}" match=${JSON.stringify(result.rule.match ?? "(any)")}` : ""}\nConfig: ${getGlobalPermissionsPath()}`,
		);
		void audit(ok ? "allow" : "deny", event.toolName, result.target, `via=${where} user-confirm`);
		if (!ok) return { block: true, reason: `Denied by user (${where}): ${label}` };
		return undefined;
	});

	pi.registerCommand("permissions-status", {
		description: "Show loaded permission layers (agent + global), validation diagnostics, and config errors",
		handler: async (_args, ctx) => {
			const s = describeStatus(ctx.cwd);
			const lines = [
				`Global: ${s.globalPath} ${s.globalExists ? `(${s.globalRuleCount} rules, default=${s.globalDefault})` : "(missing — all-default ask)"}`,
				...s.globalErrors.map((e) => `  ! ${e}`),
				`Agent: ${s.agentName ?? "(none — main session)"}${s.agentFile ? ` @ ${s.agentFile}` : ""}${s.agentExists ? ` (${s.agentRuleCount} rules${s.agentDefault ? `, default=${s.agentDefault}` : ", inherits global default"})` : ""}`,
				...s.agentErrors.map((e) => `  ! ${e}`),
				`Targets: bash→command, read/write/edit/ls→path, find/grep→path:pattern, other→JSON args.`,
			];
			const diags = withoutRetracted(collectDiagnostics(gatherFileReports(ctx.cwd), knownToolNames()));
			if (diags.length > 0) {
				lines.push(`--- validation (${diags.length}) ---`);
				for (const d of diags.slice(0, 20)) lines.push(`${d.severity}  ${d.location}: ${d.message}`);
				if (diags.length > 20) lines.push(`…and ${diags.length - 20} more`);
			}
			ctx.ui.notify(lines.join("\n"), diags.some((d) => d.severity === "error") ? "error" : "info");
		},
	});

	pi.registerCommand("permissions-check", {
		description: 'Dry-run: /permissions-check <tool> [json-args] — e.g. /permissions-check bash {"command":"rm -rf /"}',
		handler: async (args, ctx) => {
			const text = (args ?? "").trim();
			if (!text) {
				ctx.ui.notify('Usage: /permissions-check <tool> [json-args]\nTargets: bash→command, fs tools→path, other→JSON args.', "warning");
				return;
			}
			const space = text.search(/\s/);
			const tool = space === -1 ? text : text.slice(0, space);
			const rest = space === -1 ? "" : text.slice(space + 1).trim();
			let input: Record<string, unknown> = {};
			if (rest) {
				// Accept raw `key=value` shorthand for the common cases plus JSON.
				if (rest.startsWith("{")) {
					try {
						input = JSON.parse(rest) as Record<string, unknown>;
					} catch (e: any) {
						ctx.ui.notify(`Invalid JSON args: ${e?.message ?? e}`, "error");
						return;
					}
				} else {
					const m = rest.match(/^(command|path|pattern|file_path)=([\s\S]*)$/);
					if (m) input = { [m[1]]: m[2] };
					else input = { command: rest, path: rest };
				}
			}
			const r = evaluate(tool, input, ctx.cwd);
			const targets = buildTargets(tool, input, ctx.cwd);
			ctx.ui.notify(
				[
					`tool=${tool} action=${r.action} source=${r.source}${r.ruleIndex >= 0 ? ` rule#${r.ruleIndex + 1}` : ""}`,
					...(r.rule ? [`rule: tool="${r.rule.tool}" match=${JSON.stringify(r.rule.match ?? "(any)")}`] : []),
					`target: ${preview(targets[0] ?? "", 500)}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("permissions-reload", {
		description: "Reload global + agent permission configs",
		handler: async (_args, ctx) => {
			reloadAll();
			const s = describeStatus(ctx.cwd);
			ctx.ui.notify(
				`Reloaded. Global: ${s.globalExists ? `${s.globalRuleCount} rules` : "missing"}. Agent: ${s.agentName ?? "none"}.`,
				"info",
			);
		},
	});
}
