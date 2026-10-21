/**
 * Swarm Tool - fan-out template over isolated subagents.
 *
 * One call expands `template` x `items[N]` into N prompts via
 * `{item}` / `{index}` / `{count}` substitution, then runs each
 * through the shared `runSingleAgent` spawner from `../subagent`
 * (same trust boundary: minimal env, symlink containment,
 * project-agent approval gate, no recursive swarm/subagent tools).
 *
 * v1 non-goals: no mailbox, no coordinator multi-turn, no worktree
 * isolation. `stopOnError` is output-only (all spawned children run
 * to completion; partial success is not an error).
 */

import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentScope, discoverAgents, formatAgentList } from "../subagent/agents.ts";
import { runSingleAgent, type DispatchDefaults, type SingleResult } from "../subagent/index.ts";
import {
	MAX_CONCURRENCY,
	RESULT_RUNNING,
	aggregateUsage,
	emptyUsage,
	formatUsageStats,
	getFinalOutput,
	isFailedResult,
	mapWithConcurrencyLimit,
	truncateParallelOutput,
} from "../subagent/utils.ts";
import {
	MAX_SWARM_CONCURRENCY,
	MAX_SWARM_ITEMS,
	buildSwarmTasks,
	validateSwarmInput,
} from "./template.ts";

/** Tools a child may never receive (prevents recursive fan-out). */
const FORBIDDEN_CHILD_TOOLS = new Set(["swarm", "subagent"]);

interface SwarmDetails {
	mode: "swarm";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	template: string;
	items: string[];
	results: SingleResult[];
	warnings: string[];
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SwarmParams = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke for every item" }),
	template: Type.String({ description: "Prompt template with {item} and optional {index}/{count}" }),
	items: Type.Array(Type.String(), {
		description: "Items to fan out (1-20). Each becomes one child via {item} substitution.",
	}),
	agentScope: Type.Optional(AgentScopeSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent processes" })),
	maxConcurrency: Type.Optional(
		Type.Integer({ minimum: 1, maximum: MAX_SWARM_CONCURRENCY, description: "Max parallel children" }),
	),
	stopOnError: Type.Optional(
		Type.Boolean({ description: "Output-only hint in v1: noted in the header, all children still run." }),
	),
});

function formatSwarmItem(item: string, max = 40): string {
	const preview = item.length > max ? `${item.slice(0, max)}...` : item;
	return preview.replace(/\s+/g, " ");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "swarm",
		label: "Swarm",
		description: [
			"Fan out one prompt template over many items, each in an isolated subagent.",
			"template must contain {item}; {index}/{count} are optional. items: 1-20.",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SwarmParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel as ThinkingLevel | undefined,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

			const makeDetails = (results: SingleResult[], template = "", items: string[] = []): SwarmDetails => ({
				mode: "swarm",
				agentScope,
				projectAgentsDir: discovery.projectAgentsDir,
				template,
				items,
				results,
				warnings: discovery.warnings,
			});

			const validated = validateSwarmInput(params.template, params.items);
			if (!validated.ok) {
				const { text: available, remaining } = formatAgentList(agents, 20);
				const more = remaining > 0 ? ` (+${remaining} more)` : "";
				return {
					content: [{ type: "text" as const, text: `${validated.error}\nAvailable agents: ${available}${more}` }],
					details: makeDetails([]),
					isError: true,
				};
			}
			const { template, items } = validated;
			const agentName = (params.agent ?? "").trim();
			if (!agentName) {
				return {
					content: [{ type: "text" as const, text: "Invalid parameters: `agent` must be a non-empty string." }],
					details: makeDetails([], template, items),
					isError: true,
				};
			}

			// Project-local agents are repo-controlled: same approval gate as subagent.
			if (agentScope === "project" || agentScope === "both") {
				const match = agents.find((a) => a.name.toLowerCase() === agentName.toLowerCase());
				if (match?.source === "project" && !ctx.isProjectTrusted()) {
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					if (!ctx.hasUI) {
						return {
							content: [
								{
									type: "text" as const,
									text:
										`Blocked: project-local agent (${match.name}) from ${dir} requires approval, ` +
										`but there is no UI to confirm in. Run with a trusted project or a user-scoped agent.`,
								},
							],
							details: makeDetails([], template, items),
						};
					}
					const ok = await ctx.ui.confirm(
						"Run project-local agent?",
						`Agent: ${match.name}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok) {
						return {
							content: [{ type: "text" as const, text: "Canceled: project-local agent not approved." }],
							details: makeDetails([], template, items),
						};
					}
				}
			}

			// Strip recursive tools from a copy of the agent list so children
			// can never spawn their own swarm/subagent (no mutation of discovery).
			const safeAgents = agents.map((a) => {
				if (!a.tools || !a.tools.some((t) => FORBIDDEN_CHILD_TOOLS.has(t.toLowerCase()))) return a;
				const kept = a.tools.filter((t) => !FORBIDDEN_CHILD_TOOLS.has(t.toLowerCase()));
				discovery.warnings.push(`Agent "${a.name}": removed recursive tools (swarm, subagent).`);
				return { ...a, tools: kept.length > 0 ? kept : undefined };
			});

			// Fail closed: an agent whose allowlist was *entirely* recursive
			// tools must not silently fall back to unrestricted tools
			// (`tools: undefined` = all tools in runSingleAgent).
			const originalRequested = agents.find((a) => a.name.toLowerCase() === agentName.toLowerCase());
			const safeRequested = safeAgents.find((a) => a.name.toLowerCase() === agentName.toLowerCase());
			if (
				originalRequested?.tools &&
				originalRequested.tools.length > 0 &&
				(!safeRequested?.tools || safeRequested.tools.length === 0)
			) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Blocked: agent "${originalRequested.name}" only permits recursive delegation tools (swarm, subagent). Refusing to run it with unrestricted tools.`,
						},
					],
					details: makeDetails([], template, items),
					isError: true,
				};
			}

			const tasks = buildSwarmTasks(template, items);
			const concurrency = Math.max(
				1,
				Math.min(params.maxConcurrency ?? MAX_CONCURRENCY, MAX_SWARM_CONCURRENCY, tasks.length),
			);

			const allResults: SingleResult[] = tasks.map((task, i) => ({
				agent: agentName,
				agentSource: "unknown",
				task,
				cwd: ctx.cwd,
				exitCode: RESULT_RUNNING,
				messages: [],
				stderr: "",
				usage: emptyUsage(),
			}));

			const emitSwarmUpdate = () => {
				if (onUpdate) {
					const running = allResults.filter((r) => r.exitCode === RESULT_RUNNING).length;
					const done = allResults.filter((r) => r.exitCode !== RESULT_RUNNING).length;
					onUpdate({
						content: [{ type: "text" as const, text: `Swarm: ${done}/${allResults.length} done, ${running} running...` }],
						details: makeDetails([...allResults], template, items),
					});
				}
			};

			// Trivial makeDetails for the shared runner's streaming updates;
			// swarm-level aggregation uses makeDetails() above instead.
			const runnerDetails = (results: SingleResult[]) => ({ mode: "swarm-runner", results });

			const results = await mapWithConcurrencyLimit(tasks, concurrency, async (task, index) => {
				let result: SingleResult;
				try {
					result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						safeAgents,
						agentName,
						task,
						params.cwd,
						undefined,
						signal,
						(partial) => {
							if (partial.details?.results?.[0]) {
								allResults[index] = partial.details.results[0];
								emitSwarmUpdate();
							}
						},
						runnerDetails,
					);
				} catch (e) {
					if (signal?.aborted) throw e;
					result = {
						agent: agentName,
						agentSource: "unknown",
						task,
						cwd: ctx.cwd,
						exitCode: 1,
						messages: [],
						stderr: `Task failed before completion: ${(e as Error)?.message ?? e}`,
						usage: emptyUsage(),
						stopReason: "error",
						errorMessage: (e as Error)?.message ?? String(e),
					};
				}
				allResults[index] = result;
				emitSwarmUpdate();
				return result;
			});

			const successCount = results.filter((r) => !isFailedResult(r)).length;
			const stopNote = params.stopOnError ? " (stopOnError noted; all items ran in v1)" : "";
			const summaries = results.map((r, i) => {
				const output = truncateParallelOutput(getResultOutput(r));
				const status = isFailedResult(r)
					? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
					: "completed";
				return `### [${i + 1}/${results.length}: ${items[i]}] ${status} (${r.agent})\n\n${output}`;
			});
			const allFailed = successCount === 0 && results.length > 0;
			return {
				content: [
					{
						type: "text" as const,
						text: `Swarm: ${successCount}/${results.length} succeeded${stopNote}\n\n${summaries.join("\n\n---\n\n")}`,
					},
				],
				details: makeDetails(results, template, items),
				isError: allFailed,
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			const count = Array.isArray(args.items) ? args.items.length : 0;
			const agentName = args.agent || "...";
			let text =
				theme.fg("toolTitle", theme.bold("swarm ")) +
				theme.fg("accent", `${agentName} (${count} item${count === 1 ? "" : "s"})`) +
				theme.fg("muted", ` [${scope}]`);
			if (typeof args.template === "string" && args.template) {
				const clean = args.template.replace(/\{previous\}/g, "").trim();
				const preview = clean.length > 60 ? `${clean.slice(0, 60)}...` : clean;
				text += `\n  ${theme.fg("dim", preview)}`;
			}
			if (Array.isArray(args.items)) {
				for (const item of args.items.slice(0, 3)) {
					text += `\n  ${theme.fg("muted", "-")} ${theme.fg("accent", formatSwarmItem(String(item)))}`;
				}
				if (args.items.length > 3) text += `\n  ${theme.fg("muted", `... +${args.items.length - 3} more`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SwarmDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();
			const running = details.results.filter((r) => r.exitCode === RESULT_RUNNING).length;
			const successCount = details.results.filter(
				(r) => r.exitCode !== RESULT_RUNNING && !isFailedResult(r),
			).length;
			const failCount = details.results.filter(
				(r) => r.exitCode !== RESULT_RUNNING && isFailedResult(r),
			).length;
			const isRunning = running > 0;
			const icon = isRunning
				? theme.fg("warning", "⏳")
				: failCount > 0
					? theme.fg("warning", "◐")
					: theme.fg("success", "✓");
			const status = isRunning
				? `${successCount + failCount}/${details.results.length} done, ${running} running`
				: `${successCount}/${details.results.length} items`;

			const renderItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					}
				}
				return text.trimEnd();
			};

			if (expanded && !isRunning) {
				const container = new Container();
				container.addChild(
					new Text(
						`${icon} ${theme.fg("toolTitle", theme.bold("swarm "))}${theme.fg("accent", status)}`,
						0,
						0,
					),
				);
				details.results.forEach((r, i) => {
					const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
					const label = details.items[i] ?? `item ${i + 1}`;
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(`${theme.fg("muted", `─── [${i + 1}/${details.results.length}: `) + theme.fg("accent", formatSwarmItem(label, 60))}${theme.fg("muted", "] ")} ${rIcon}`, 0, 0),
					);
					const displayItems = getDisplayItems(r.messages);
					const finalOutput = getFinalOutput(r.messages);
					if (finalOutput) {
						container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
					} else if (displayItems.length === 0) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
				});
				const total = aggregateUsage(details.results);
				const totalStr = formatUsageStats(total);
				if (totalStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total: ${totalStr}`), 0, 0));
				}
				return container;
			}

			let text = `${icon} ${theme.fg("toolTitle", theme.bold("swarm "))}${theme.fg("accent", status)}`;
			details.results.forEach((r, i) => {
				const label = details.items[i] ?? `item ${i + 1}`;
				const rIcon =
					r.exitCode === RESULT_RUNNING
						? theme.fg("warning", "⏳")
						: isFailedResult(r)
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				text += `\n\n${theme.fg("muted", `─── [${i + 1}/${details.results.length}: `)}${theme.fg("accent", formatSwarmItem(label, 60))} ${rIcon}`;
				if (displayItems.length === 0) {
					text += `\n${theme.fg("muted", r.exitCode === RESULT_RUNNING ? "(running...)" : "(no output)")}`;
				} else {
					text += `\n${renderItems(displayItems, 5)}`;
				}
			});
			if (!isRunning) {
				const totalStr = formatUsageStats(aggregateUsage(details.results));
				if (totalStr) text += `\n\n${theme.fg("dim", `Total: ${totalStr}`)}`;
			}
			if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(text, 0, 0);
		},
	});
}

export { MAX_SWARM_ITEMS };
