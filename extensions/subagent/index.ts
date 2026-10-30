/**
 * Subagent Tool - Delegate tasks to specialized agents (thin wiring).
 *
 * Orchestration lives in single.ts / parallel.ts /
 * swarm-orchestrator.ts; rendering primitives in render.ts; params in
 * schema.ts; resilience in resilience.ts. This file only wires the
 * `subagent` tool + swarm admin tools/commands to those modules.
 *
 * Modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Swarm: { swarm: { goal, workers: [{ id, agent, task }...], merger? } }
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentList } from "./agents.ts";
import { runParallel } from "./parallel.ts";
import {
	COLLAPSED_ITEM_COUNT,
	formatToolCall,
	formatTotals,
	getDisplayItems,
	getResultOutput,
	resultBadges,
	truncatePreview,
} from "./render.ts";
import { DEFAULT_RETRY_ATTEMPTS, DEFAULT_RETRY_BACKOFF_MS, runWithRetry } from "./resilience.ts";
import { SubagentParams } from "./schema.ts";
import { runSingleAgent } from "./single.ts";
import { createForwardedPermissionStore } from "./forwarded-permissions.ts";
import { validateSubagentFormat } from "./validate.ts";
import {
	isCancelled,
	listSwarmRuns,
	pruneSwarmRuns,
	readDoneFiles,
	readManifest,
	requestCancel,
} from "./swarm.ts";
import { createSwarmRun } from "./swarm.ts";
import { resumeMissingWorkers, runSwarm, validateWorkers } from "./swarm-orchestrator.ts";
import { askUserToolDefinition } from "./ask-user-tool.ts";
import type { ParentUI, SingleResult, SubagentDetails, SwarmInfo } from "./types.ts";
import {
	MAX_PARALLEL_TASKS,
	RESULT_RUNNING,
	clampTimeoutMs,
	formatUsageStats,
	generateRunId,
	getFinalOutput,
	isFailedResult,
	nextSwarmDepth,
	parseSwarmDepth,
	truncateSingleOutput,
} from "./utils.ts";

export type { SingleResult, SubagentDetails, SwarmInfo } from "./types.ts";
export { runSingleAgent } from "./single.ts";
export { createForwardedPermissionStore } from "./forwarded-permissions.ts";

export default function (pi: ExtensionAPI) {
	// Parent-side memo for forwarded child permission prompts: "Allow for
	// this session" means the main session, scoped per agent. Identical
	// repeated dialogs from later children of the same agent auto-approve
	// without re-prompting. In-memory only, cleared on session shutdown —
	// same lifetime as the permissions extension's own sessionGrants.
	// Exact-title match only (v1).
	const forwardedPermissions = createForwardedPermissionStore();

	pi.on("session_shutdown", () => {
		try {
			forwardedPermissions.clear();
		} catch {
			/* never break shutdown */
		}
	});
	pi.registerTool({
		name: askUserToolDefinition.name,
		label: askUserToolDefinition.label,
		description: askUserToolDefinition.description,
		parameters: askUserToolDefinition.parameters,
		outputSchema: (askUserToolDefinition as any).outputSchema,
		defaultActive: (askUserToolDefinition as any).defaultActive,
		exposure: (askUserToolDefinition as any).exposure,
		promptSnippet: (askUserToolDefinition as any).promptSnippet,
		promptGuidelines: (askUserToolDefinition as any).promptGuidelines,
		async execute(toolCallId, params: any, signal, onUpdate, ctx: any) {
			return (askUserToolDefinition as any).execute(toolCallId, params, signal, onUpdate, ctx);
		},
	} as any);

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array),",
			"swarm ({goal, workers[{id,agent,task}], merger?} hierarchical blackboard in .swarm/<runId>/).",
			"Resilience: retry {attempts, backoffMs} (default retry once), totalTimeoutMs (whole-operation budget),",
			"onError abort|continue (default continue for parallel/swarm).",
			"Questions: child ask_user calls and permission prompts are forwarded to the user (serialized across workers);",
			"set allowQuestions:false to auto-dismiss, questionTimeoutMs to bound each dialog.",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params: any, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const parentUI: ParentUI = {
				hasUI: ctx.hasUI,
				select: (title, options, opts) => ctx.ui.select(title, options, opts as any),
				confirm: (title, message, opts) => ctx.ui.confirm(title, message, opts as any),
				input: (title, placeholder, opts) => ctx.ui.input(title, placeholder, opts as any),
				notify: (message, type) => ctx.ui.notify(message, type),
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const hasSwarm = Boolean(params.swarm && params.swarm.workers?.length);

			const parentDepth = parseSwarmDepth(process.env["PI_SUBAGENT_DEPTH"]);

			const makeDetails =
				(mode: "single" | "parallel" | "swarm", swarm?: SwarmInfo) =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
					warnings: discovery.warnings,
					...(swarm ? { swarm } : {}),
				});

			const retryAttempts = Math.max(1, Math.min(5, Math.floor(params.retry?.attempts ?? DEFAULT_RETRY_ATTEMPTS)));
			const retryBackoffMs = Math.max(0, params.retry?.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS);

			// Format first: malformed payloads fail here, before the
			// project-local agent trust-approval dialog below prompts the user.
			const { text: available, remaining } = formatAgentList(agents, 20);
			const more = remaining > 0 ? ` (+${remaining} more)` : "";
			const formatCheck = validateSubagentFormat(params, agents, { availableText: `${available}${more}` });
			if (formatCheck.error) {
				return {
					content: [{ type: "text", text: formatCheck.error }],
					details: makeDetails(formatCheck.mode)([]),
					...(formatCheck.isError ? { isError: true } : {}),
				};
			}

			// Project-local agents are repo-controlled content: they always
			// require approval on untrusted projects.
			if (agentScope === "project" || agentScope === "both") {
				const requestedAgentNames = new Set<string>();
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);
				if (params.swarm) {
					for (const w of params.swarm.workers) requestedAgentNames.add(w.agent);
					if (params.swarm.merger) requestedAgentNames.add(params.swarm.merger.agent);
				}

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name.toLowerCase() === name.toLowerCase()))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0 && !ctx.isProjectTrusted()) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					if (!ctx.hasUI) {
						return {
							content: [
								{
									type: "text",
									text:
										`Blocked: project-local agents (${names}) from ${dir} require approval, ` +
										`but there is no UI to confirm in. Run with a trusted project or a user-scoped agent.`,
								},
							],
							details: makeDetails(hasTasks ? "parallel" : hasSwarm ? "swarm" : "single")([]),
						};
					}
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasTasks ? "parallel" : hasSwarm ? "swarm" : "single")([]),
						};
				}
			}

			if (params.swarm && params.swarm.workers.length > 0) {
				const spec = params.swarm;
				const workersErr = validateWorkers(spec.workers);
				if (workersErr)
					return { content: [{ type: "text", text: workersErr }], details: makeDetails("swarm")([]) };
				const depthCheck = nextSwarmDepth(parentDepth);
				if ("error" in depthCheck)
					return { content: [{ type: "text", text: `Swarm rejected: ${depthCheck.error}.` }], details: makeDetails("swarm")([]) };
				const workerDepth = depthCheck.depth;
				const runId = generateRunId();
				let run;
				try {
					run = await createSwarmRun(ctx.cwd, runId);
				} catch (e) {
					return {
						content: [{ type: "text", text: `Swarm setup failed: ${(e as Error)?.message ?? e}` }],
						details: makeDetails("swarm")([]),
						isError: true,
					};
				}
				const swarmInfo: SwarmInfo = { runId, swarmDir: run.swarmDir, depth: workerDepth };
				try {
					const out = await runSwarm(runId, run.swarmDir, spec.goal, spec.workers, spec.merger, {
						fallbackTimeoutMs: params.timeoutMs,
						retryAttempts,
						retryBackoffMs,
						totalTimeoutMs: params.totalTimeoutMs,
						cleanup: spec.cleanup,
						allowQuestions: params.allowQuestions,
						questionTimeoutMs: params.questionTimeoutMs,
					}, {
						defaultCwd: ctx.cwd,
						dispatchDefaults,
						agents,
						signal,
						onUpdate: onUpdate as any,
						makeDetails: (results: SingleResult[]) => makeDetails("swarm", swarmInfo)(results),
						workerDepth,
						parentUI,
						forwardedPermissions,
					});
					return {
						content: [{ type: "text", text: out.text }],
						details: makeDetails("swarm", out.swarmInfo)(out.results),
						isError: out.isError,
					};
				} catch (e) {
					if ((e as Error)?.message === "Subagent was aborted") throw e;
					return {
						content: [{ type: "text", text: `Swarm ${runId} failed: ${(e as Error)?.message ?? e}. Blackboard kept at ${run.swarmDir}.` }],
						details: makeDetails("swarm", swarmInfo)([]),
						isError: true,
					};
				}
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
						details: makeDetails("parallel")([]),
					};
				const out = await runParallel(params.tasks, {
					fallbackTimeoutMs: params.timeoutMs,
					retryAttempts,
					retryBackoffMs,
					totalTimeoutMs: params.totalTimeoutMs,
					onError: params.onError ?? "continue",
					allowQuestions: params.allowQuestions,
					questionTimeoutMs: params.questionTimeoutMs,
				}, {
					defaultCwd: ctx.cwd,
					dispatchDefaults,
					agents,
					signal,
					onUpdate: onUpdate as any,
					makeDetails: makeDetails("parallel"),
					parentUI,
					forwardedPermissions,
				});
				return { content: [{ type: "text", text: out.text }], details: makeDetails("parallel")(out.results), isError: out.allFailed };
			}

			if (params.agent && params.task) {
				const timeoutCheck = clampTimeoutMs(params.timeoutMs);
				if (timeoutCheck.error) {
					return {
						content: [{ type: "text", text: `Invalid timeoutMs: ${timeoutCheck.error}.` }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
				const { result, attempts } = await runWithRetry(
					() =>
						runSingleAgent(
							ctx.cwd, dispatchDefaults, agents, params.agent, params.task, params.cwd,
							undefined, signal, onUpdate as any, makeDetails("single"), undefined,
							{
								timeoutMs: params.timeoutMs,
								allowQuestions: params.allowQuestions,
								questionTimeoutMs: params.questionTimeoutMs,
								parentUI,
								forwardedPermissions,
								labelPrefix: `[${params.agent}]`,
							},
						),
					{ attempts: retryAttempts, backoffMs: retryBackoffMs, signal },
				);
				const finalResult: SingleResult = { ...result, attempts };
				const isError = isFailedResult(finalResult);
				if (isError) {
					const errorMsg = getResultOutput(finalResult);
					return {
						content: [{ type: "text", text: `Agent ${finalResult.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([finalResult]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: truncateSingleOutput(getFinalOutput(finalResult.messages) || "(no output)") }],
					details: makeDetails("single")([finalResult]),
				};
			}

			const { text: availableFallback, remaining: availableMore } = formatAgentList(agents, 20);
			const moreSuffix = availableMore > 0 ? ` (+${availableMore} more)` : "";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${availableFallback}${moreSuffix}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${truncatePreview(t.task, 40)}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.swarm && args.swarm.workers?.length > 0) {
				const workers = args.swarm.workers;
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `swarm (${workers.length} workers${args.swarm.merger ? " + merger" : ""})`) +
					theme.fg("muted", ` [${scope}]`);
				for (const w of workers.slice(0, 3)) {
					text += `\n  ${theme.fg("accent", `${w.id}:${w.agent}`)}${theme.fg("dim", ` ${truncatePreview(w.task, 40)}`)}`;
				}
				if (workers.length > 3) text += `\n  ${theme.fg("muted", `... +${workers.length - 3} more`)}`;
				if (args.swarm.goal) text += `\n  ${theme.fg("dim", `goal: ${truncatePreview(args.swarm.goal, 80)}`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? truncatePreview(args.task, 60) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: ReturnType<typeof getDisplayItems>, limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);
				const { errorBadge, durationBadge } = resultBadges(r);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}${theme.fg("dim", durationBadge)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]${errorBadge}`)}`;
					else if (errorBadge) header += theme.fg("dim", errorBadge);
					if (r.timedOut) header += ` ${theme.fg("error", "[timed out]")}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}${theme.fg("dim", durationBadge)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]${errorBadge}`)}`;
				else if (errorBadge) text += theme.fg("dim", errorBadge);
				if (r.timedOut) text += ` ${theme.fg("error", "[timed out]")}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === RESULT_RUNNING).length;
				const successCount = details.results.filter((r) => r.exitCode !== RESULT_RUNNING && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== RESULT_RUNNING && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning ? theme.fg("warning", "⏳") : failCount > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
				const status = isRunning ? `${successCount + failCount}/${details.results.length} done, ${running} running` : `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, 0, 0));

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0));
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
							}
						}

						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const totals = formatTotals(details.results);
					if (totals) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${totals}`), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon = r.exitCode === RESULT_RUNNING ? theme.fg("warning", "⏳") : isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === RESULT_RUNNING ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const totals = formatTotals(details.results);
					if (totals) text += `\n\n${theme.fg("dim", `Total: ${totals}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "swarm") {
				const running = details.results.filter((r) => r.exitCode === RESULT_RUNNING).length;
				const successCount = details.results.filter((r) => r.exitCode !== RESULT_RUNNING && !isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning ? theme.fg("warning", "⏳") : theme.fg("success", "✓");
				const swarmLine = details.swarm ? ` ${details.swarm.runId} @ ${details.swarm.swarmDir}` : "";
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("swarm "))}${theme.fg("accent", `${successCount}/${details.results.length} workers`)}${theme.fg("muted", swarmLine)}`;
				for (const r of details.results) {
					const rIcon = r.exitCode === RESULT_RUNNING ? theme.fg("warning", "⏳") : isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === RESULT_RUNNING ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const totals = formatTotals(details.results);
					if (totals) text += `\n\n${theme.fg("dim", `Total: ${totals}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	pi.registerTool({
		name: "swarm_status",
		label: "Swarm status",
		description: "Show status of a .swarm/<runId>/ blackboard: manifest, done/* workers, cancel flag.",
		parameters: Type.Object({
			runId: Type.String({ description: "Swarm runId (e.g. swarm-20240101-120000-ab12, forks append -rN)" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const swarmDir = path.join(ctx.cwd, ".swarm", params.runId);
			const manifest = await readManifest(swarmDir);
			const done = await readDoneFiles(swarmDir).catch(() => []);
			const cancelled = await isCancelled(swarmDir);
			if (!manifest && done.length === 0) {
				try {
					await fs.promises.access(swarmDir);
				} catch {
					return { content: [{ type: "text", text: `Swarm ${params.runId} not found under ${ctx.cwd}/.swarm/.` }], details: {} as any, isError: true };
				}
			}
			const total = manifest?.workers.length ?? done.length;
			const lines = [
				`Swarm ${params.runId}: status=${manifest?.status ?? "unknown (pre-manifest run)"}${cancelled ? " CANCEL-REQUESTED" : ""}`,
				`Goal: ${manifest?.goal ?? "(unknown)"}`,
				`Workers: ${done.length}/${total} done${manifest?.parentRunId ? ` (forked from ${manifest.parentRunId})` : ""}`,
				...done.map((d) => ` - done/${d.id}.md (${Buffer.byteLength(d.body, "utf8")} bytes)`),
			];
			return { content: [{ type: "text", text: lines.join("\n") }], details: { manifest, done: done.map((d) => d.id), cancelled } as any };
		},
	});

	pi.registerTool({
		name: "swarm_cancel",
		label: "Swarm cancel",
		description: "Request cancellation of a running swarm (writes cancel.json; workers stop between tasks).",
		parameters: Type.Object({
			runId: Type.String({ description: "Swarm runId to cancel" }),
			reason: Type.Optional(Type.String({ description: "Cancel reason recorded in cancel.json" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const swarmDir = path.join(ctx.cwd, ".swarm", params.runId);
			try {
				await fs.promises.access(swarmDir);
			} catch {
				return { content: [{ type: "text", text: `Swarm ${params.runId} not found.` }], details: {} as any, isError: true };
			}
			await requestCancel(swarmDir, params.reason ?? "cancel requested via swarm_cancel");
			return { content: [{ type: "text", text: `Swarm ${params.runId} cancel requested.` }], details: { runId: params.runId } as any };
		},
	});

	pi.registerTool({
		name: "swarm_resume",
		label: "Swarm resume",
		description: "Fork-resume a swarm: creates <runId>-rN, copies parent done/*.md, runs only missing workers, then merger.",
		parameters: Type.Object({
			runId: Type.String({ description: "Parent runId to resume from" }),
			merger: Type.Optional(Type.Object({
				agent: Type.String(),
				task: Type.String(),
				cwd: Type.Optional(Type.String()),
				timeoutMs: Type.Optional(Type.Number()),
			})),
			cleanup: Type.Optional(Type.Boolean()),
			timeoutMs: Type.Optional(Type.Number()),
			totalTimeoutMs: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const dispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, "user");
			const parentDepth = parseSwarmDepth(process.env["PI_SUBAGENT_DEPTH"]);
			const depthCheck = nextSwarmDepth(parentDepth);
			if ("error" in depthCheck)
				return { content: [{ type: "text", text: `Swarm resume rejected: ${depthCheck.error}.` }], details: {} as any, isError: true };
			const resumeUI: ParentUI = {
				hasUI: ctx.hasUI,
				select: (title, options, opts) => ctx.ui.select(title, options, opts as any),
				confirm: (title, message, opts) => ctx.ui.confirm(title, message, opts as any),
				input: (title, placeholder, opts) => ctx.ui.input(title, placeholder, opts as any),
				notify: (message, type) => ctx.ui.notify(message, type),
			};
			const out = await resumeMissingWorkers(ctx.cwd, params.runId, params.merger, {
				fallbackTimeoutMs: params.timeoutMs,
				retryAttempts: DEFAULT_RETRY_ATTEMPTS,
				retryBackoffMs: DEFAULT_RETRY_BACKOFF_MS,
				totalTimeoutMs: params.totalTimeoutMs,
				cleanup: params.cleanup,
			}, {
				defaultCwd: ctx.cwd,
				dispatchDefaults,
				agents: discovery.agents,
				signal,
				onUpdate: onUpdate as any,
				makeDetails: (results: SingleResult[], swarm?: SwarmInfo) => ({
					mode: "swarm" as const,
					agentScope: "user" as const,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
					warnings: discovery.warnings,
					...(swarm ? { swarm } : {}),
				}),
				workerDepth: depthCheck.depth,
				parentUI: resumeUI,
				forwardedPermissions,
			});
			if ("error" in out)
				return { content: [{ type: "text", text: `Swarm resume failed: ${out.error}` }], details: {} as any, isError: true };
			return { content: [{ type: "text", text: out.text }], details: { mode: "swarm", results: out.results, swarm: out.swarmInfo } as any, isError: out.isError };
		},
	});

	pi.registerTool({
		name: "swarm_gc",
		label: "Swarm GC",
		description:
			"List/prune stale .swarm/<runId>/ blackboard dirs. Dry-run by default; pass apply:true to delete. A run is deleted only when older than olderThanDays AND outside the newest keepLastN.",
		parameters: Type.Object({
			olderThanDays: Type.Optional(Type.Number({ description: "Delete runs older than N days (default 7)" })),
			keepLastN: Type.Optional(Type.Number({ description: "Always keep newest N runs (default 10)" })),
			apply: Type.Optional(Type.Boolean({ description: "Actually delete (default false = dry-run)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!params.apply) {
				const runs = await listSwarmRuns(ctx.cwd);
				const preview = await pruneSwarmRuns(ctx.cwd, {
					olderThanDays: params.olderThanDays,
					keepLastN: params.keepLastN,
					dryRun: true,
				});
				const lines = runs.slice(0, 20).map((r) => {
					const age = `${Math.round((Date.now() - r.mtimeMs) / 86400000)}d`;
					const mark = preview.deleted.includes(r.runId) ? " [would delete]" : "";
					return `${r.runId} age=${age} ${(r.sizeBytes / 1024).toFixed(1)}KB${mark}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Swarm runs: ${runs.length}. Would delete ${preview.deleted.length} (${(preview.freedBytes / 1024).toFixed(1)}KB). Pass apply:true to delete.\n${lines.join("\n") || "(no runs)"}`,
						},
					],
					details: { preview } as any,
				};
			}
			const res = await pruneSwarmRuns(ctx.cwd, {
				olderThanDays: params.olderThanDays,
				keepLastN: params.keepLastN,
				dryRun: false,
			});
			return {
				content: [
					{
						type: "text",
						text: res.deleted.length === 0
							? `Swarm GC: nothing to delete (kept ${res.kept.length}).`
							: `Swarm GC: deleted ${res.deleted.length} run(s), freed ${(res.freedBytes / 1024).toFixed(1)}KB. Kept ${res.kept.length}.\n${res.deleted.join("\n")}`,
					},
				],
				details: res as any,
			};
		},
	});

	pi.registerCommand("swarm-gc", {
		description: "Prune stale .swarm/<runId>/ dirs: /swarm-gc [--older-than N] [--keep-last N] [--apply]",
		handler: async (args, ctx) => {
			const text = args ?? "";
			const num = (re: RegExp): number | undefined => {
				const m = text.match(re);
				if (!m) return undefined;
				const n = Number(m[1]);
				return Number.isFinite(n) && n >= 0 ? n : undefined;
			};
			const olderThan = num(/--older-than\s+(\d+(?:\.\d+)?)/) ?? 7;
			const keepLast = num(/--keep-last\s+(\d+)/) ?? 10;
			const apply = text.includes("--apply");
			const res = await pruneSwarmRuns(ctx.cwd, {
				olderThanDays: olderThan,
				keepLastN: keepLast,
				dryRun: !apply,
			});
			const verb = apply ? "Deleted" : "Would delete";
			ctx.ui.notify(
				`Swarm GC (${apply ? "applied" : "dry-run"}): ${verb.toLowerCase()} ${res.deleted.length} run(s)${res.deleted.length > 0 ? `, freed ${(res.freedBytes / 1024).toFixed(1)}KB` : ""}. Kept ${res.kept.length}.\n${res.deleted.slice(0, 20).join("\n")}${res.deleted.length > 20 ? `\n... +${res.deleted.length - 20} more` : ""}${apply ? "" : "\nPass --apply to delete."}`,
				"info",
			);
		},
	});
}
