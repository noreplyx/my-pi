/**
 * `ask_user` — LLM-callable question tool for subagent children (Option C).
 *
 * Registered by the subagent extension so every `pi` process (parent and
 * `--mode rpc` child) has it. Whether the *model* sees it is gated by
 * `--tools`: the parent only passes `ask_user` in `--tools` when the
 * agent's frontmatter `tools:` lists it (frontmatter-gated per Q2).
 *
 * In a `--mode rpc` child, `ctx.ui.select/input` emits
 * `extension_ui_request` on stdout; the parent's forwarder in `single.ts`
 * proxies it to the real user and writes `extension_ui_response` back.
 * In normal interactive use the tool just calls `ctx.ui` directly.
 */

import { Type } from "typebox";

export const AskUserParams = Type.Object({
	question: Type.String({ description: "Question to ask the user (one specific question)." }),
	options: Type.Optional(Type.Array(Type.String(), { description: "Choice list. When provided, the user picks one. Omit for free-text input." })),
	placeholder: Type.Optional(Type.String({ description: "Placeholder hint for free-text input (ignored when options is set)." })),
});

export const AskUserOutputSchema = Type.Object({
	answer: Type.Union([Type.String(), Type.Null()], { description: "Selected option or typed text. Null when the user dismissed." }),
	dismissed: Type.Boolean({ description: "True when the user dismissed without answering." }),
});

export const askUserToolDefinition = {
	name: "ask_user",
	label: "Ask user",
	description: [
		"Ask the user a single specific question and wait for the answer.",
		"Use options for choices (the user picks one), omit options for free-text.",
		"Ask ONE question per call; batch independent questions with parallel tool calls.",
		"Only available when the agent frontmatter lists ask_user in tools.",
	].join(" "),
	parameters: AskUserParams,
	outputSchema: AskUserOutputSchema,
	// Available on request only: parent interactive sessions don't see it
	// unless enabled, children see it only when `--tools` includes it.
	defaultActive: false,
	exposure: "direct" as const,
	promptSnippet: "ask_user(question, options?) — ask the user one question",
	promptGuidelines: [
		"When you need user input to proceed, call ask_user instead of stalling: one question per call, 2-4 options when choices are known.",
		"Never call ask_user for secrets or credentials.",
	],

	async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
		const question = typeof params?.question === "string" ? params.question : "";
		const options = Array.isArray(params?.options) ? params.options.filter((o: unknown) => typeof o === "string") : [];
		const placeholder = typeof params?.placeholder === "string" ? params.placeholder : undefined;
		if (!question.trim()) {
			return {
				content: [{ type: "text", text: "ask_user: question is required." }],
				details: { dismissed: true, answer: null },
				structuredContent: { answer: null, dismissed: true },
				isError: true,
			};
		}
		if (!ctx?.hasUI) {
			return {
				content: [{ type: "text", text: `ask_user dismissed (no UI): ${question.slice(0, 200)}` }],
				details: { dismissed: true, answer: null },
				structuredContent: { answer: null, dismissed: true },
			};
		}
		try {
			if (options.length > 0) {
				const picked = await ctx.ui.select(question, options.slice(0, 20), signal ? { signal } : undefined);
				if (picked === undefined) {
					return {
						content: [{ type: "text", text: `User dismissed question: ${question.slice(0, 200)}` }],
						details: { dismissed: true, answer: null },
						structuredContent: { answer: null, dismissed: true },
					};
				}
				return {
					content: [{ type: "text", text: `User answered: ${picked}` }],
					details: { dismissed: false, answer: picked },
					structuredContent: { answer: picked, dismissed: false },
				};
			}
			const text = await ctx.ui.input(question, placeholder, signal ? { signal } : undefined);
			if (text === undefined) {
				return {
					content: [{ type: "text", text: `User dismissed question: ${question.slice(0, 200)}` }],
					details: { dismissed: true, answer: null },
					structuredContent: { answer: null, dismissed: true },
				};
			}
			return {
				content: [{ type: "text", text: `User answered: ${text}` }],
				details: { dismissed: false, answer: text },
				structuredContent: { answer: text, dismissed: false },
			};
		} catch (e) {
			return {
				content: [{ type: "text", text: `ask_user failed: ${(e as Error)?.message ?? e}` }],
				details: { dismissed: true, answer: null },
				structuredContent: { answer: null, dismissed: true },
				isError: true,
			};
		}
	},
};
