/**
 * Agent Switch — `/agent` command for true main-session agent switching.
 *
 * Switching applies four things from the picked `agents/*.md` file:
 *   1. System prompt — injected via `before_agent_start` into
 *      `systemPromptOptions.sections["agent"]` (recorded in the transcript
 *      like any other prompt delta; history is kept).
 *   2. Tools — strict: `pi.setActiveTools(agent.tools)`.
 *   3. Model — when the agent pins `model: provider/id`, resolved through
 *      `ctx.modelRegistry.find()` and applied with `pi.setModel()`.
 *      Failures warn and keep the current model.
 *   4. Permissions — the permissions extension keys its per-agent layer off
 *      `PI_AGENT_NAME`/`PI_AGENT_FILE` (permissions/loader.ts), which are
 *      absent in the main session. Setting them here activates the picked
 *      agent's `permissions:` frontmatter. Global `deny` rules still win
 *      over everything (fail-closed precedence is unchanged).
 *
 * State is session-only: cleared on `session_start` (any reason, so a
 * same-process `/reload` resets to default) and on `session_shutdown`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { discoverAgents, formatAgentList, type AgentConfig } from "../subagent/agents.ts";
import { normalizeAgentName, validateModelString } from "../subagent/utils.ts";
import { describeStatus } from "../permissions/loader.ts";

const ENV_NAME = "PI_AGENT_NAME";
const ENV_FILE = "PI_AGENT_FILE";
const STATUS_KEY = "agent-switch";
const WIDGET_KEY = "agent-switch";
const RESET_WORDS = new Set(["reset", "default", "clear", "off"]);

/** Active override. Null = default session (no agent). */
let current: AgentConfig | null = null;
/** Tool set captured at session start, restored on reset. */
let defaultTools: string[] | null = null;
/** Pre-switch env values, restored on reset. Captured once per process. */
let priorsCaptured = false;
let priorName: string | undefined;
let priorFile: string | undefined;

function clearAgentEnv(): void {
	delete process.env[ENV_NAME];
	delete process.env[ENV_FILE];
}

function truncate(s: string, max: number): string {
	const oneLine = s.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function labelFor(a: AgentConfig, isCurrent: boolean): string {
	const mark = isCurrent ? "● " : "";
	return `${mark}${a.name} — ${truncate(a.description, 80)} [${a.source}]`;
}

function findAgent(agents: AgentConfig[], query: string): AgentConfig | undefined {
	const key = normalizeAgentName(query.trim());
	if (!key) return undefined;
	return agents.find((a) => normalizeAgentName(a.name) === key);
}

function usageLine(): string {
	return "Usage: /agent (picker) · /agent <name> · /agent reset";
}

function statusText(ctx: ExtensionCommandContext): void {
	try {
		ctx.ui.setStatus(STATUS_KEY, current ? `agent:${current.name}` : undefined);
	} catch {
		// Status bar is TUI-only; never break the switch on it.
	}
	try {
		// Persistent one-liner above the editor, shown only while switched.
		ctx.ui.setWidget(WIDGET_KEY, current ? [`agent: ${current.name}`] : undefined, {
			placement: "aboveEditor",
		});
	} catch {
		// Widgets are TUI-only; never break the switch on them.
	}
}

function permissionsLine(ctx: ExtensionCommandContext): string {
	try {
		const s = describeStatus(ctx.cwd);
		if (!s.agentExists) return "permissions: none declared (global rules only)";
		const errs = s.agentErrors.length > 0 ? ` (! ${truncate(s.agentErrors[0], 100)})` : "";
		return `permissions: ${s.agentRuleCount} rule${s.agentRuleCount === 1 ? "" : "s"} from ${s.agentFile ?? s.agentName}${errs}`;
	} catch {
		return "permissions: unknown (status check failed)";
	}
}

async function applyAgent(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	agent: AgentConfig,
): Promise<void> {
	await ctx.waitForIdle();

	current = agent;
	process.env[ENV_NAME] = agent.name;
	process.env[ENV_FILE] = agent.filePath;

	// Strict tools: the model may only use what the agent declares. An agent
	// without a `tools:` list keeps the session default (no restriction given).
	const tools = agent.tools ?? defaultTools ?? pi.getActiveTools();
	pi.setActiveTools(tools);

	// Warn about requested tools that are not registered (setActiveTools
	// ignores them silently).
	let unknownTools: string[] = [];
	try {
		const known = new Set(pi.getAllTools().map((t) => t.name));
		unknownTools = tools.filter((t) => !known.has(t));
	} catch {
		// Tool list unavailable — skip the check, the switch itself stands.
	}

	// Model: only when pinned. Anything unresolvable warns and keeps current.
	let modelLine = "model: unchanged (none pinned)";
	if (agent.model !== undefined) {
		const check = validateModelString(agent.model);
		const slash = check.model?.indexOf("/") ?? -1;
		if (check.error || !check.model) {
			modelLine = `model: kept current (invalid model entry: ${check.error ?? "empty"})`;
		} else if (slash === -1) {
			modelLine = `model: kept current (cannot parse provider/id from "${truncate(check.model, 40)}")`;
		} else {
			const provider = check.model.slice(0, slash);
			const id = check.model.slice(slash + 1);
			const model = ctx.modelRegistry.find(provider, id);
			if (!model) {
				modelLine = `model: kept current ("${truncate(check.model, 60)}" not in catalogue)`;
			} else {
				const ok = await pi.setModel(model);
				modelLine = ok
					? `model: ${check.model}`
					: `model: kept current ("${truncate(check.model, 60)}" auth not configured)`;
			}
		}
	}

	statusText(ctx);
	const lines = [
		`Switched to ${agent.name} (${agent.source}).`,
		`tools: ${tools.length > 0 ? tools.join(", ") : "(none — model has no tools)"}`,
		modelLine,
		permissionsLine(ctx),
	];
	if (unknownTools.length > 0) {
		lines.push(`warning: not registered, ignored: ${unknownTools.join(", ")}`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

function resetAgent(pi: ExtensionAPI, ctx: ExtensionCommandContext, why: string): void {
	current = null;
	if (priorName === undefined) delete process.env[ENV_NAME];
	else process.env[ENV_NAME] = priorName;
	if (priorFile === undefined) delete process.env[ENV_FILE];
	else process.env[ENV_FILE] = priorFile;
	if (defaultTools) {
		try {
			pi.setActiveTools(defaultTools);
		} catch {
			// Restore is best-effort; the env/prompt reset below still stands.
		}
	}
	statusText(ctx);
	ctx.ui.notify(`${why} Agent reset to default session.`, "info");
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (event, ctx) => {
		if (event.reason === "startup" && !priorsCaptured) {
			// First start in this process: remember any externally provided
			// identity (normally absent) so reset restores exactly that.
			priorName = process.env[ENV_NAME];
			priorFile = process.env[ENV_FILE];
		}
		if (event.reason !== "startup") {
			// Reload / new / resume / fork: a new session starts clean.
			priorName = undefined;
			priorFile = undefined;
		}
		priorsCaptured = true;
		current = null;
		clearAgentEnv();
		try {
			defaultTools = pi.getActiveTools();
		} catch {
			defaultTools = null;
		}
		statusText(ctx);
	});

	// Idempotent cleanup: a follow-on session in the same process must never
	// inherit a stale agent identity.
	pi.on("session_shutdown", (_event, ctx) => {
		current = null;
		clearAgentEnv();
		statusText(ctx);
	});

	pi.on("before_agent_start", (event) => {
		if (!current) return;
		event.systemPromptOptions.sections["agent"] =
			`Active agent: ${current.name} (${current.source}, ${current.filePath})\n\n${current.systemPrompt}`;
	});

	pi.registerCommand("agent", {
		description: "Switch main-session agent (prompt, tools, model, permissions) — /agent [name|reset]",
		getArgumentCompletions: (argumentPrefix) => {
			const names = new Set<string>(["reset"]);
			try {
				const dir = path.join(getAgentDir(), "agents");
				for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
					if (entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink())) {
						names.add(entry.name.slice(0, -".md".length));
					}
				}
			} catch {
				// Best-effort only; fall back to just "reset".
			}
			const prefix = (argumentPrefix ?? "").toLowerCase();
			const items = [...names]
				.filter((n) => n.toLowerCase().startsWith(prefix))
				.sort()
				.map((n) => ({ value: n, label: n }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const query = (args ?? "").trim();

			if (RESET_WORDS.has(query.toLowerCase())) {
				resetAgent(pi, ctx, "Reset. ");
				return;
			}

			const discovery = discoverAgents(ctx.cwd, "both");
			const agents = discovery.agents;
			if (agents.length === 0) {
				ctx.ui.notify("No agents found in user or project agents directories.", "warning");
				return;
			}
			if (discovery.warnings.length > 0) {
				ctx.ui.notify(
					`Agent discovery warnings:\n${discovery.warnings.slice(0, 5).map((w) => `- ${truncate(w, 160)}`).join("\n")}` +
						(discovery.warnings.length > 5 ? `\n…and ${discovery.warnings.length - 5} more` : ""),
					"warning",
				);
			}

			// Direct switch: /agent <name>. Works without UI (scripts, RPC).
			if (query) {
				const agent = findAgent(agents, query);
				if (!agent) {
					const { text: available, remaining } = formatAgentList(agents, 20);
					ctx.ui.notify(
						`Unknown agent: "${truncate(query, 60)}". Available: ${available}${remaining > 0 ? ` (+${remaining} more)` : ""}`,
						"error",
					);
					return;
				}
				if (agent.source === "project" && !ctx.isProjectTrusted()) {
					// Repo-controlled content: same fail-closed gate the
					// subagent extension applies to project-local agents.
					if (!ctx.hasUI) {
						ctx.ui.notify(
							`Blocked: project-local agent "${agent.name}" requires approval, but there is no UI to confirm in.`,
							"error",
						);
						return;
					}
					const ok = await ctx.ui.confirm(
						`Switch to project-local agent "${agent.name}"?`,
						`Source: ${agent.filePath}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok) {
						ctx.ui.notify("Canceled: agent switch not approved.", "warning");
						return;
					}
				}
				await applyAgent(pi, ctx, agent);
				return;
			}

			// Picker: /agent with no args.
			if (!ctx.hasUI) {
				const { text: available, remaining } = formatAgentList(agents, 20);
				ctx.ui.notify(
					`${usageLine()}\nCurrent: ${current ? `${current.name} (${current.source})` : "(default session)"}\nAvailable: ${available}${remaining > 0 ? ` (+${remaining} more)` : ""}`,
					"info",
				);
				return;
			}
			const defaultLabel = `(default session — clear override)${current ? "" : " ●"}`;
			const labels = [defaultLabel, ...agents.map((a) => labelFor(a, a.name === current?.name))];
			let picked: string | undefined;
			try {
				picked = await ctx.ui.select("Choose agent", labels, {
					...(ctx.signal ? { signal: ctx.signal } : {}),
				});
			} catch {
				ctx.ui.notify("Agent picker unavailable on this client. Use /agent <name> instead.", "warning");
				return;
			}
			if (picked === undefined) return; // Dismissed — fail closed, no change.
			if (picked === defaultLabel) {
				resetAgent(pi, ctx, "Cleared. ");
				return;
			}
			const agent = agents[labels.indexOf(picked) - 1];
			if (!agent) return; // Should not happen; never apply an unknown agent.
			if (agent.source === "project" && !ctx.isProjectTrusted()) {
				const ok = await ctx.ui.confirm(
					`Switch to project-local agent "${agent.name}"?`,
					`Source: ${agent.filePath}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
				);
				if (!ok) {
					ctx.ui.notify("Canceled: agent switch not approved.", "warning");
					return;
				}
			}
			await applyAgent(pi, ctx, agent);
		},
	});

	pi.registerCommand("agents", {
		description: "List available agents (● = current)",
		handler: async (_args, ctx) => {
			const discovery = discoverAgents(ctx.cwd, "both");
			const lines = [
				`Current: ${current ? `${current.name} (${current.source})` : "(default session)"}`,
				...discovery.agents.map(
					(a) => `${a.name === current?.name ? "●" : "○"} ${a.name} [${a.source}] — ${truncate(a.description, 80)}`,
				),
			];
			if (discovery.agents.length === 0) lines.push("(no agents found)");
			if (discovery.warnings.length > 0) {
				lines.push(
					`warnings:\n${discovery.warnings.slice(0, 5).map((w) => `- ${truncate(w, 160)}`).join("\n")}` +
						(discovery.warnings.length > 5 ? `\n…and ${discovery.warnings.length - 5} more` : ""),
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
