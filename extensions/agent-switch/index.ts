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
 *  4. Permissions — the permissions extension keys its layer off
 *      `PI_AGENT_NAME`/`PI_AGENT_FILE` (permissions/loader.ts). The main
 *      session without a switch falls back to `agents/main.md`; setting
 *      them here activates the picked agent's `permissions:` frontmatter
 *      instead (fail-closed precedence is unchanged).
 *
 * State is persisted: a switch writes `defaultAgent` to the global
 * `settings.json` (model-memory parity) and every `session_start`
 * restores it, so new sessions/processes keep the selection until an
 * explicit `/agent reset`. In-memory identity is still cleared on
 * `session_shutdown`. An externally injected identity (subagent
 * child `PI_AGENT_NAME`/`PI_AGENT_FILE` from the spawner) is never wiped:
 * with no in-process switch active, `session_start`/`session_shutdown`
 * leave the environment untouched so the permissions layer keeps reading
 * the injected agent.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { discoverAgents, formatAgentList, type AgentConfig } from "../subagent/agents.ts";
import { normalizeAgentName, validateModelString } from "../subagent/utils.ts";
import { describeStatus } from "../permissions/loader.ts";
import {
	persistAgentAsDefault,
	readPersistedAgent,
	resolveAgentDir,
} from "./persist.ts";
import {
	AgentPickerComponent,
	type AgentPickerItem,
} from "./picker.ts";

const ENV_NAME = "PI_AGENT_NAME";
const ENV_FILE = "PI_AGENT_FILE";
const STATUS_KEY = "agent-switch";
const RESET_WORDS = new Set(["reset", "default", "clear", "off"]);

/** Active override. Null = default session (no agent). */
let current: AgentConfig | null = null;
/** Warned-once flags per process (avoid repeat noise on every session). */
let warnedMissingAgent: string | null = null;
let warnedUntrustedAgent: string | null = null;

/** Agent dir for settings.json persistence (model-memory parity). */
function resolvePersistDir(): string {
	try {
		return getAgentDir();
	} catch {
		return resolveAgentDir(process.env);
	}
}

/** Best-effort persistence: warn only, never break the switch/reset. */
function saveSelection(ctx: ExtensionContext, name: string | null): void {
	try {
		const result = persistAgentAsDefault(resolvePersistDir(), name);
		if (!result.ok && !result.skipped) {
			ctx.ui.notify(`Agent switch: could not save default (${result.error})`, "warning");
		}
	} catch (error) {
		try {
			ctx.ui.notify(
				`Agent switch: could not save default (${error instanceof Error ? error.message : String(error)})`,
				"warning",
			);
		} catch {
			// UI unavailable — never break the session for a memory write.
		}
	}
}
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

function statusText(ctx: ExtensionContext): void {
	try {
		ctx.ui.setStatus(STATUS_KEY, current ? `agent:${current.name}` : undefined);
	} catch {
		// Status bar is TUI-only; never break the switch on it.
	}
}

function permissionsLine(ctx: ExtensionContext): string {
	try {
		const s = describeStatus(ctx.cwd);
		if (!s.agentExists) return "permissions: none declared (all-default ask)";
		const errs = s.agentErrors.length > 0 ? ` (! ${truncate(s.agentErrors[0], 100)})` : "";
		return `permissions: ${s.agentRuleCount} rule${s.agentRuleCount === 1 ? "" : "s"} from ${s.agentFile ?? s.agentName}${errs}`;
	} catch {
		return "permissions: unknown (status check failed)";
	}
}

async function applyAgent(
	pi: ExtensionAPI,
	ctx: ExtensionContext | ExtensionCommandContext,
	agent: AgentConfig,
	options?: { persist?: boolean },
): Promise<void> {
	// `waitForIdle` exists only on the command-handler context
	// (ExtensionCommandContext). Lifecycle event contexts (e.g.
	// `session_start`) never provide it, and at `session_start` no turn is
	// streaming so there is nothing to wait for — `defaultTools` was already
	// captured fresh above the restore call. Guard instead of calling
	// unconditionally so auto-restore never throws `waitForIdle is not a
	// function`.
	const maybeCommandCtx = ctx as Partial<ExtensionCommandContext>;
	if (typeof maybeCommandCtx.waitForIdle === "function") {
		await maybeCommandCtx.waitForIdle();
	}

	current = agent;
	process.env[ENV_NAME] = agent.name;
	process.env[ENV_FILE] = agent.filePath;
	if (options?.persist !== false) saveSelection(ctx, agent.name);

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

function resetAgent(pi: ExtensionAPI, ctx: ExtensionContext, why: string): void {
	current = null;
	warnedMissingAgent = null;
	warnedUntrustedAgent = null;
	saveSelection(ctx, null);
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
	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "startup" && !priorsCaptured) {
			// First start in this process: remember any externally provided
			// identity (normally absent) so reset restores exactly that.
			priorName = process.env[ENV_NAME];
			priorFile = process.env[ENV_FILE];
		}
		if (event.reason !== "startup") {
			// Reload / new / resume / fork: priors from process start no
			// longer apply; a reset returns to a clean default session.
			priorName = undefined;
			priorFile = undefined;
		}
		priorsCaptured = true;
		if (current !== null) {
			// Identity came from an in-process `/agent` switch in a previous
			// session (e.g. same-process `/reload`): drop the in-memory
			// identity here; the persisted `defaultAgent` restore below
			// re-applies it when still valid.
			// When current is null the env is left untouched, so an
			// externally injected identity (subagent child
			// PI_AGENT_NAME/PI_AGENT_FILE, set before startup) survives —
			// the permissions layer reads it lazily per tool call.
			current = null;
			if (priorName === undefined) delete process.env[ENV_NAME];
			else process.env[ENV_NAME] = priorName;
			if (priorFile === undefined) delete process.env[ENV_FILE];
			else process.env[ENV_FILE] = priorFile;
		}
		try {
			defaultTools = pi.getActiveTools();
		} catch {
			defaultTools = null;
		}
		statusText(ctx);
		// Restore the persisted default (if any) on every session start —
		// global-default semantics, model-memory parity. Explicit
		// `/agent reset` clears the key, so a reset session stays default.
		// An externally injected identity always wins over the persisted
		// choice and must never be overwritten.
		if (current !== null) return;
		if (process.env[ENV_NAME] !== undefined || process.env[ENV_FILE] !== undefined) return;
		let persisted: { name: string } | null = null;
		try {
			persisted = readPersistedAgent(resolvePersistDir());
		} catch {
			return;
		}
		if (!persisted) return;
		let agents: AgentConfig[];
		try {
			agents = discoverAgents(ctx.cwd, "both").agents;
		} catch {
			return;
		}
		const agent = findAgent(agents, persisted.name);
		if (!agent) {
			// Stale entry (agent deleted/renamed, or unknown in this
			// repo): fail to default cleanly and drop the key so the
			// warning does not repeat on every session.
			try {
				persistAgentAsDefault(resolvePersistDir(), null);
			} catch {
				// Best-effort cleanup only.
			}
			if (warnedMissingAgent !== persisted.name) {
				warnedMissingAgent = persisted.name;
				try {
					ctx.ui.notify(
						`Saved agent "${truncate(persisted.name, 60)}" not found; staying on default session.`,
						"warning",
					);
				} catch {
					// UI unavailable — stay default silently.
				}
			}
			return;
		}
		if (agent.source === "project") {
			// Repo-controlled content: never auto-apply without trust.
			// Cannot reliably await confirm during session_start, so
			// stay default and prompt for an explicit re-confirm.
			let trusted = false;
			try {
				trusted = ctx.isProjectTrusted();
			} catch {
				trusted = false;
			}
			if (!trusted) {
				if (warnedUntrustedAgent !== agent.name) {
					warnedUntrustedAgent = agent.name;
					try {
						ctx.ui.notify(
							`Saved agent "${agent.name}" is project-local and needs approval; run /agent ${agent.name} to confirm.`,
							"warning",
						);
					} catch {
						// UI unavailable — stay default silently.
					}
				}
				return;
			}
		}
		// defaultTools was captured above, so applyAgent sees the fresh
			// session default. Silent persist avoids a write loop.
		await applyAgent(pi, ctx, agent, { persist: false });
	});

	// Idempotent cleanup: a follow-on session in the same process must never
	// inherit a stale switched identity. Like session_start, this only acts
	// on an in-process switch — an externally injected identity is left
	// alone (the process is normally exiting anyway).
	pi.on("session_shutdown", (_event, ctx) => {
		if (current !== null) {
			current = null;
			clearAgentEnv();
		}
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

			// Direct switch: /agent <name>. An exact match applies immediately
			// without a picker (mirrors /model); anything else seeds the
			// searchable picker below. Works without UI (scripts, RPC) for
			// exact names only.
			let initialSearch: string | undefined;
			if (query) {
				const agent = findAgent(agents, query);
				if (agent) {
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
				if (!ctx.hasUI) {
					const { text: available, remaining } = formatAgentList(agents, 20);
					ctx.ui.notify(
						`Unknown agent: "${truncate(query, 60)}". Available: ${available}${remaining > 0 ? ` (+${remaining} more)` : ""}`,
						"error",
					);
					return;
				}
				// No exact match: fall through to the picker seeded with the
				// typed text (mirrors /model <term> with no exact match).
				initialSearch = query;
			} else if (!ctx.hasUI) {
				const { text: available, remaining } = formatAgentList(agents, 20);
				ctx.ui.notify(
					`${usageLine()}\nCurrent: ${current ? `${current.name} (${current.source})` : "(default session)"}\nAvailable: ${available}${remaining > 0 ? ` (+${remaining} more)` : ""}`,
					"info",
				);
				return;
			}

			// Searchable picker (mirrors /model): type to fuzzy-filter, ↑↓ to
			// move, Enter to switch, Esc to cancel fail-closed.
			const defaultLabel = `(default session — clear override)${current ? "" : " ●"}`;
			const items: AgentPickerItem[] = [
				{ label: defaultLabel, agent: null },
				...agents.map((a) => ({
					label: labelFor(a, a.name === current?.name),
					agent: a as AgentConfig,
				})),
			];
			let picked: AgentPickerItem | undefined;
			try {
				picked = await ctx.ui.custom<AgentPickerItem | undefined>(
					(tui, theme, _keybindings, done) =>
						new AgentPickerComponent(
							tui,
							theme,
							items,
							current?.name,
							(item) => done(item),
							() => done(undefined),
							initialSearch,
						),
				);
			} catch {
				ctx.ui.notify("Agent picker unavailable on this client. Use /agent <name> instead.", "warning");
				return;
			}
			if (picked === undefined) return; // Dismissed — fail closed, no change.
			if (picked.agent === null) {
				resetAgent(pi, ctx, "Cleared. ");
				return;
			}
			const agent = picked.agent;
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
}
