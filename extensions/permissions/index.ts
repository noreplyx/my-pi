/**
 * Permission enforcement extension (agent-only — no global policy file).
 *
 * Each agent declares its policy in `permissions:` frontmatter in
 * agents/*.md (inline or via external file). The main session (no agent)
 * is governed by agents/main.md. Undeclared tools fall back to `ask`.
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
import { buildTargets, describeCall, describeStatus, evaluate, loadAllAgentFiles, reloadAll, resolveGrantDir, resolveGrantPath, warnStalePermissionsFileEnv } from "./loader.ts";
import { matchToolName } from "./matcher.ts";
import { isAutoApproveEnabled } from "../auto-approve/state.ts";
import { createSessionGrants, SESSION_CHOICE_DENY_FEEDBACK, SESSION_CHOICE_ONCE, SESSION_CHOICE_SESSION, SESSION_CHOICES } from "./session-grants.ts";
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

function preview(s: string, max = 120): string {
	const oneLine = s.replace(/\s+/g, " ").trim() || "(no args)";
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Max length (incl. ellipsis) for deny-with-feedback text in block reasons / audit. */
const FEEDBACK_CAP = 500;

/** Gather all agent configs for validation. Never throws. */
function gatherFileReports(cwd: string): FileReport[] {
	const reports: FileReport[] = [];
	try {
		const files = loadAllAgentFiles(cwd);
		for (const a of files) {
			reports.push({ label: a.label, exists: true, validated: a.validated, isAgent: true });
		}
		// Surface a missing main-session policy (agents/main.md) as a report.
		const s = describeStatus(cwd);
		if (!s.agentExists && !process.env.PI_AGENT_NAME?.trim() && !process.env.PI_AGENT_FILE?.trim()) {
			reports.push({
				label: s.agentFile ?? "agents/main.md",
				exists: false,
				validated: { config: { defaultAction: "ask", rules: [] }, errors: [], hasDefault: false },
				isAgent: true,
			});
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

	// Session-scoped "Allow for this session" grants. File tools grant the
	// whole directory (recursive down, never up); other tools grant the exact
	// tool + target pair. In-memory only — never persisted anywhere,
	// cleared on session shutdown (idempotent) so a new
	// session starts clean. A new extension runtime (reload/replacement)
	// also starts with an empty store by construction.
	const sessionGrants = createSessionGrants();
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
			const staleEnv = warnStalePermissionsFileEnv();
			const diags = withoutRetracted(collectDiagnostics(gatherFileReports(ctx.cwd), knownToolNames()));
			if (staleEnv) {
				diags.push({ severity: "warning", location: "PI_PERMISSIONS_FILE", message: staleEnv });
			}
			if (diags.length === 0) return;
			const text = formatStartupReport(diags);
			const level = diags.some((d) => d.severity === "error") ? "error" : "warning";
			if (ctx.hasUI) ctx.ui.notify(text, level);
			else console.warn(text); // stderr only — never stdout (would corrupt --mode json)
		} catch {
			// validation must never break startup
		}
	});

	// Session grants die with the session. Idempotent — shutdown can fire via
	// cancellation, reload, replacement, and process exit converging.
	pi.on("session_shutdown", async () => {
		sessionGrants.clear();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (seenTools.size < 1000) seenTools.add(event.toolName);
		const input = (event.input ?? {}) as Record<string, unknown>;
		const result = evaluate(event.toolName, input, ctx.cwd);

		if (result.action === "allow") return undefined;

		const where =
			result.source === "agent"
				? result.ruleIndex >= 0
					? `agent rule #${result.ruleIndex + 1}`
					: `agent default`
				: `default (ask)`;
		const label = `${event.toolName} ${preview(result.target)}`.trim();
		// Chain context: which segment decided a chained bash/powershell call.
		const chainInfo =
			result.segmentCount && result.segmentCount > 1
				? ` segment=${(result.segmentIndex ?? 0) + 1}/${result.segmentCount} seg=${JSON.stringify((result.segment ?? "").slice(0, 120))}`
				: "";

		if (result.action === "deny") {
			void audit("deny", event.toolName, result.target, `via=${where}${chainInfo}`);
			const reasonSeg = chainInfo ? ` (segment ${(result.segmentIndex ?? 0) + 1}/${result.segmentCount}: ${preview(result.segment ?? "")})` : "";
			return { block: true, reason: `Blocked by permissions (${where})${reasonSeg}: ${label}` };
		}

		// action === "ask"
		// Auto-approve (session-only toggle): ask prompts auto-allow without
		// a dialog. Deny already returned above — this never bypasses deny.
		// Audited like any other allow so the log stays complete.
		if (isAutoApproveEnabled()) {
			void audit("allow", event.toolName, result.target, `via=auto-approve ${where}${chainInfo}`);
			return undefined;
		}
		// 1. Session grant hit — exact tool + target, or (file tools) a
		//    directory grant covering this call's directory (recursive down,
		//    never up: a child grant does not cover the parent).
		if (sessionGrants.has(event.toolName, result.target)) {
			void audit("allow", event.toolName, result.target, `via=${where} session-grant`);
			return undefined;
		}
		const grantPath = resolveGrantPath(event.toolName, input, ctx.cwd);
		if (grantPath && sessionGrants.hasDirectory(event.toolName, grantPath)) {
			void audit("allow", event.toolName, result.target, `via=${where} session-grant-dir`);
			return undefined;
		}
		if (!ctx.hasUI) {
			void audit("deny", event.toolName, result.target, `via=${where} ask-without-ui`);
			return { block: true, reason: `Blocked by permissions (${where}, no UI to confirm): ${label}` };
		}
		const st = describeStatus(ctx.cwd);
		const message =
			`${label}\n\nMatched ${where}${result.rule ? ` — tool="${result.rule.tool}" match=${JSON.stringify(result.rule.match ?? "(any)")}` : ""}${chainInfo}\nAgent: ${st.agentName ?? "(none)"}${st.agentFile ? ` @ ${st.agentFile}` : ""}`;
		// select() has no body slot — the summary (`write src/foo.txt`)
		// goes into the dialog title so every choice carries context.
		// The same title is used for the confirm fallback, so no dialog
		// path ever shows a generic title. The title is also audit-logged
		// on user decisions, so "what did the dialog show?" is answerable
		// from the log alone.
		const summary = describeCall(event.toolName, input, ctx.cwd);
		// describeCall already caps bash at ~120 chars; this is a second
		// guard so future tool summaries can never blow up the dialog title.
		// Swarm summaries are intentionally multiline + untruncated (option A):
		// exempt them here so the full worker/goal list reaches the prompt.
		const isSwarmSummary = event.toolName.toLowerCase() === "subagent" && summary.includes("swarm (");
		const shortSummary = !isSwarmSummary && summary.length > 140 ? `${summary.slice(0, 139)}…` : summary;
		const dialogTitle = `Allow ${shortSummary}?`;
		let choice: string | undefined;
		try {
			choice = await ctx.ui.select(dialogTitle, [...SESSION_CHOICES], {
				...(ctx.signal ? { signal: ctx.signal } : {}),
			});
		} catch {
			// select() unavailable on this client (e.g. older RPC) — fall back
			// to the legacy binary confirm rather than failing open.
			// Fail closed: a throwing confirm (RPC disconnect, abort,
			// headless) is an explicit deny, never a bubble-out exception.
			let ok: boolean;
			try {
				ok = await ctx.ui.confirm(dialogTitle, message);
			} catch {
				return { block: true, reason: `Denied by user (${where}): ${label}` };
			}
			void audit(ok ? "allow" : "deny", event.toolName, result.target, `via=${where} user-confirm title=${JSON.stringify(dialogTitle)}`);
			if (!ok) return { block: true, reason: `Denied by user (${where}): ${label}` };
			return undefined;
		}
		if (choice === SESSION_CHOICE_SESSION) {
			// File tools: one approval covers the whole directory for the
			// session (recursive down). Anything else: exact target only.
			const dir = resolveGrantDir(event.toolName, input, ctx.cwd);
			if (dir) {
				sessionGrants.addDirectory(event.toolName, dir, where);
				void audit("allow", event.toolName, result.target, `via=${where} user-allow-session dir=${dir} title=${JSON.stringify(dialogTitle)}`);
			} else {
				sessionGrants.add(event.toolName, result.target, where);
				void audit("allow", event.toolName, result.target, `via=${where} user-allow-session title=${JSON.stringify(dialogTitle)}`);
			}
			return undefined;
		}
		if (choice === SESSION_CHOICE_ONCE) {
			void audit("allow", event.toolName, result.target, `via=${where} user-allow-once title=${JSON.stringify(dialogTitle)}`);
			return undefined;
		}
		if (choice === SESSION_CHOICE_DENY_FEEDBACK) {
			// Deny with feedback: ask what to do instead. Fail closed —
			// dismiss/empty/throw degrades to a plain deny.
			let feedback: string | undefined;
			try {
				feedback = await ctx.ui.input("Deny feedback — why denied / what to do instead?", "e.g. use read instead of bash, or skip this step", {
					...(ctx.signal ? { signal: ctx.signal } : {}),
				});
			} catch {
				feedback = undefined;
			}
			const trimmed = (feedback ?? "").trim();
			if (!trimmed) {
				void audit("deny", event.toolName, result.target, `via=${where} user-deny-feedback-empty title=${JSON.stringify(dialogTitle)}`);
				return { block: true, reason: `Denied by user (${where}): ${label}` };
			}
			const capped = trimmed.length > FEEDBACK_CAP ? `${trimmed.slice(0, FEEDBACK_CAP - 1)}…` : trimmed;
			void audit("deny", event.toolName, result.target, `via=${where} user-deny-feedback title=${JSON.stringify(dialogTitle)} feedback=${JSON.stringify(capped)}`);
			return { block: true, reason: `Denied by user (${where}): ${label}. Feedback: ${capped}` };
		}
		// SESSION_CHOICE_DENY or undefined (dismissed/escape) — fail closed.
		void audit("deny", event.toolName, result.target, `via=${where} user-deny title=${JSON.stringify(dialogTitle)}`);
		return { block: true, reason: `Denied by user (${where}): ${label}` };
	});

	pi.registerCommand("permissions-status", {
		description: "Show loaded agent permission layer, validation diagnostics, and config errors",
		handler: async (_args, ctx) => {
			const s = describeStatus(ctx.cwd);
			const lines = [
				`Agent: ${s.agentName ?? "(none)"}${s.agentFile ? ` @ ${s.agentFile}` : ""}${s.agentExists ? ` (${s.agentRuleCount} rules${s.agentDefault ? `, default=${s.agentDefault}` : ", no default — falls back to ask"})` : " (missing — all-default ask)"}`,
				`Auto-approve: ${isAutoApproveEnabled() ? "ON (ask→allow, deny still blocks)" : "OFF"} (/auto-approve on|off|status)`,
				...s.agentErrors.map((e) => `  ! ${e}`),
				`Targets: bash→command, read/write/edit/ls→path, find/grep→path:pattern, other→JSON args.`,
			];
			const diags = withoutRetracted(collectDiagnostics(gatherFileReports(ctx.cwd), knownToolNames()));
			if (diags.length > 0) {
				lines.push(`--- validation (${diags.length}) ---`);
				for (const d of diags.slice(0, 20)) lines.push(`${d.severity}  ${d.location}: ${d.message}`);
				if (diags.length > 20) lines.push(`…and ${diags.length - 20} more`);
			}
			const grants = sessionGrants.list();
			lines.push(`--- session grants (${grants.length}) ---`);
			for (const g of grants.slice(0, 20)) {
				lines.push(
					g.scope === "directory"
						? `allow  ${g.tool} ${preview(g.target, 120)}/ (recursive, ${g.where})`
						: `allow  ${g.tool} ${preview(g.target, 120)} (${g.where})`,
				);
			}
			if (grants.length > 20) lines.push(`…and ${grants.length - 20} more (use /permissions-clear-session to revoke)`);
			ctx.ui.notify(lines.join("\n"), diags.some((d) => d.severity === "error") ? "error" : "info");
		},
	});

	pi.registerCommand("permissions-check", {
		description:
			'Dry-run: /permissions-check [--as-agent <name>] <tool> [json-args] — e.g. /permissions-check --as-agent reviewer bash {"command":"rm -rf /"}',
		handler: async (args, ctx) => {
			let text = (args ?? "").trim();
			if (!text) {
				ctx.ui.notify(
					'Usage: /permissions-check [--as-agent <name>] <tool> [json-args]\nTargets: bash→command, fs tools→path, other→JSON args.\n--as-agent evaluates as that agent would (its own frontmatter layer + ask fallback).',
					"warning",
				);
				return;
			}
			// Extract optional --as-agent flag (both `--as-agent name` and `--as-agent=name`).
			let asAgent: string | null = null;
			const eq = text.match(/(?:^|\s)--as-agent=([^\s]+)\s*/);
			if (eq) {
				asAgent = eq[1];
				text = text.replace(eq[0], " ").trim();
			} else {
				const sp = text.match(/(?:^|\s)--as-agent\s+([^\s]+)\s*/);
				if (sp) {
					asAgent = sp[1];
					text = text.replace(sp[0], " ").trim();
				}
			}
			if (!text) {
				ctx.ui.notify("Usage: /permissions-check [--as-agent <name>] <tool> [json-args]", "warning");
				return;
			}
			// Temporarily assume the target agent identity so evaluate() loads its
			// frontmatter exactly as the child `pi` process would (PI_AGENT_NAME/FILE).
			const savedName = process.env.PI_AGENT_NAME;
			const savedFile = process.env.PI_AGENT_FILE;
			let asAgentFile: string | null = null;
			if (asAgent) {
				if (asAgent.endsWith(".md")) {
					try {
						const { statSync } = await import("node:fs");
						statSync(asAgent);
						asAgentFile = asAgent;
					} catch {
						asAgentFile = null;
					}
				}
				try {
					if (asAgentFile) process.env.PI_AGENT_FILE = asAgentFile;
					else {
						process.env.PI_AGENT_NAME = asAgent;
						delete process.env.PI_AGENT_FILE;
					}
					reloadAll();
				} catch {
					// fall through with whatever identity we have; evaluate still works
				}
			}
			try {
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
				const status = describeStatus(ctx.cwd);
				ctx.ui.notify(
					[
						`tool=${tool} action=${r.action} source=${r.source}${r.ruleIndex >= 0 ? ` rule#${r.ruleIndex + 1}` : ""}${r.segmentCount && r.segmentCount > 1 ? ` segment=${(r.segmentIndex ?? 0) + 1}/${r.segmentCount}` : ""}${asAgent ? ` as-agent=${asAgent}` : ""}`,
						...(asAgent ? [`agent: ${status.agentName ?? "(unknown)"}${status.agentFile ? ` @ ${status.agentFile}` : ""}`] : []),
						...(r.rule ? [`rule: tool="${r.rule.tool}" match=${JSON.stringify(r.rule.match ?? "(any)")}`] : []),
						...(r.segmentCount && r.segmentCount > 1 && r.segment ? [`segment: ${preview(r.segment, 200)}`] : []),
						`target: ${preview(targets[0] ?? "", 500)}`,
						...(r.action === "ask" && isAutoApproveEnabled() ? [`runtime: auto-approve ON — would allow (deny still blocks)`] : []),
					].join("\n"),
					"info",
				);
			} finally {
				if (asAgent) {
					try {
						if (savedName === undefined) delete process.env.PI_AGENT_NAME;
						else process.env.PI_AGENT_NAME = savedName;
						if (savedFile === undefined) delete process.env.PI_AGENT_FILE;
						else process.env.PI_AGENT_FILE = savedFile;
						reloadAll();
					} catch {
						// never break the session on env restore
					}
				}
			}
		},
	});

	pi.registerCommand("permissions-clear-session", {
		description: "Revoke all 'Allow for this session' grants (prompts will ask again)",
		handler: async (_args, ctx) => {
			const n = sessionGrants.clear();
			ctx.ui.notify(n === 0 ? "No session grants to clear." : `Cleared ${n} session grant${n === 1 ? "" : "s"}. Future calls will prompt again.`, "info");
		},
	});

	pi.registerCommand("permissions-reload", {
		description: "Reload agent permission configs",
		handler: async (_args, ctx) => {
			reloadAll();
			const s = describeStatus(ctx.cwd);
			ctx.ui.notify(
				`Reloaded. Agent: ${s.agentName ?? "none"}${s.agentExists ? ` (${s.agentRuleCount} rules)` : " (missing — all-default ask)"}.`,
				"info",
			);
		},
	});
}
