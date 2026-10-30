/**
 * TypeBox schemas for the subagent tool params.
 *
 * Moved from index.ts + extended with resilience fields:
 * retry / totalTimeoutMs / onError (additive; old payloads still validate).
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentScope } from "./agents.ts";

export const TimeoutMsSchema = Type.Optional(
	Type.Number({ description: "Wall-clock budget in ms (default 300000, max 1800000)" }),
);

export const RetrySchema = Type.Optional(
	Type.Object({
		attempts: Type.Optional(Type.Number({ description: "Total attempts, 1-5 (default 2 = retry once)" })),
		backoffMs: Type.Optional(Type.Number({ description: "Base backoff between attempts in ms (default 1000)" })),
	}),
);

export const TotalTimeoutMsSchema = Type.Optional(
	Type.Number({
		description:
			"Total budget for the whole parallel/swarm operation in ms (default unset = unbounded; parallel/swarm: max + 60s)",
	}),
);

export const OnErrorSchema = Type.Optional(
	Type.Union([Type.Literal("abort"), Type.Literal("continue")], {
		description: 'On worker failure: "abort" stops, "continue" keeps going (default: continue for parallel/swarm)',
	}),
);

export const AllowQuestionsSchema = Type.Optional(
	Type.Boolean({ description: "Allow the subagent to ask the user questions via ask_user (default true). When false, questions are auto-dismissed." }),
);

export const QuestionTimeoutMsSchema = Type.Optional(
	Type.Number({ description: "Per-question dialog budget in ms (default: inherit task timeout). Unanswered questions auto-dismiss." }),
);

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	timeoutMs: TimeoutMsSchema,
	allowQuestions: AllowQuestionsSchema,
	questionTimeoutMs: QuestionTimeoutMsSchema,
});

export const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SwarmWorker = Type.Object({
	id: Type.String({ description: "Worker ID (lowercase, used for done/<id>.md + inbox/<id>.jsonl)" }),
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the worker" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the worker process" })),
	timeoutMs: TimeoutMsSchema,
	allowQuestions: AllowQuestionsSchema,
	questionTimeoutMs: QuestionTimeoutMsSchema,
});

const SwarmSpec = Type.Object({
	goal: Type.String({ description: "Overall swarm goal recorded in tasks.jsonl" }),
	workers: Type.Array(SwarmWorker, { description: "Workers to run in parallel (max 8)" }),
	merger: Type.Optional(
		Type.Object({
			agent: Type.String({ description: "Agent to synthesize worker outputs" }),
			task: Type.String({ description: "Merger task synthesizing worker outputs. `{previous}` is replaced with packed worker outputs (see MERGER_INPUT_BUDGET)." }),
			cwd: Type.Optional(Type.String({ description: "Working directory for the merger process" })),
			timeoutMs: TimeoutMsSchema,
			allowQuestions: AllowQuestionsSchema,
			questionTimeoutMs: QuestionTimeoutMsSchema,
		}),
	),
	cleanup: Type.Optional(
		Type.Boolean({ description: "Delete .swarm/<runId>/ when all workers + merger succeed (default false)" }),
	),
	resumeFrom: Type.Optional(
		Type.String({ description: "Fork-resume: parent runId to copy goal/worker specs from (creates <parent>-rN dir)" }),
	),
});

export const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	swarm: Type.Optional(SwarmSpec),
	agentScope: Type.Optional(AgentScopeSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	timeoutMs: TimeoutMsSchema,
	retry: RetrySchema,
	totalTimeoutMs: TotalTimeoutMsSchema,
	onError: OnErrorSchema,
	allowQuestions: AllowQuestionsSchema,
	questionTimeoutMs: QuestionTimeoutMsSchema,
});

export type SubagentParamsType = typeof SubagentParams.static;
export type SwarmSpecType = typeof SwarmSpec.static;

export function defaultAgentScope(): AgentScope {
	return "user";
}
