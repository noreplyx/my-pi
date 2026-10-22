/**
 * Shared types for the subagent extension.
 *
 * Extracted from index.ts so single/parallel/chain/swarm-orchestrator/render
 * can share them without circular imports.
 */
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentScope } from "./agents.ts";
import type { SubagentErrorCode, UsageStats } from "./utils.ts";

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	/** Resolved absolute working directory the agent process ran in. */
	cwd: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	/** Machine-readable cause. "ok" when the process exited 0 without error/abort. */
	errorCode: SubagentErrorCode;
	/** True when the result was produced by the timeout killer (not a user abort). */
	timedOut: boolean;
	/** Wall-clock time for this agent process, ms. */
	durationMs: number;
	/** How many attempts were made (1 = no retry). Set by runWithRetry. */
	attempts?: number;
}

export interface SwarmInfo {
	runId: string;
	swarmDir: string;
	depth: number;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain" | "swarm";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	/** Non-fatal discovery diagnostics (shadowed/skipped agents). */
	warnings: string[];
	swarm?: SwarmInfo;
}

export interface SwarmCtx {
	depth: number;
	swarmDir: string;
	runId: string;
	agentId: string;
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface RunSingleAgentOptions {
	/** Per-agent wall-clock budget in ms. Undefined → TIMEOUT_DEFAULT_MS (clamped to TIMEOUT_MAX_MS). */
	timeoutMs?: number;
}
