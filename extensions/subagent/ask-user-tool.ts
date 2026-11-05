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

export const ASK_USER_CUSTOM_OPTION = "Other (type custom answer)...";
const DEFAULT_CUSTOM_INPUT_PLACEHOLDER = "Type your custom answer...";
const MAX_BASE_SELECT_OPTIONS = 19;
const CUSTOM_OPTION_LABEL_PATTERN = /^(?:other|custom|something else|type (?:a )?custom\b)(?:\b|\s|[.(:—-])/i;

export function isCustomOptionLabel(label: string): boolean {
	if (typeof label !== "string") return false;
	return CUSTOM_OPTION_LABEL_PATTERN.test(label.trim());
}

export function prepareSelectOptions(rawOptions: string[]): { choices: string[]; customLabels: Set<string> } {
	const choices = (Array.isArray(rawOptions) ? rawOptions : [])
		.filter((option): option is string => typeof option === "string")
		.map((option) => option.trim())
		.filter((option) => option.length > 0)
		.slice(0, MAX_BASE_SELECT_OPTIONS);
	const customLabels = new Set<string>();
	if (choices.length === 0) {
		return { choices, customLabels };
	}
	for (const choice of choices) {
		if (isCustomOptionLabel(choice)) {
			customLabels.add(choice);
		}
	}
	if (customLabels.size === 0) {
		choices.push(ASK_USER_CUSTOM_OPTION);
		customLabels.add(ASK_USER_CUSTOM_OPTION);
	}
	return { choices, customLabels };
}

let askUserLockTail: Promise<void> = Promise.resolve();

export function withAskUserLock<T>(interaction: () => Promise<T>): Promise<T> {
	const previous = askUserLockTail;
	let releaseLock!: () => void;
	askUserLockTail = new Promise<void>((resolve) => {
		releaseLock = resolve;
	});
	return previous.then(interaction).finally(releaseLock);
}

function buildDismissedResult(question: string) {
	return {
		content: [{ type: "text", text: `User dismissed question: ${question.slice(0, 200)}` }],
		details: { dismissed: true, answer: null },
		structuredContent: { answer: null, dismissed: true },
	};
}

function buildAnsweredResult(answer: string) {
	return {
		content: [{ type: "text", text: `User answered: ${answer}` }],
		details: { dismissed: false, answer },
		structuredContent: { answer, dismissed: false },
	};
}

export const AskUserParams = Type.Object({
	question: Type.String({ description: "Question to ask the user (one specific question)." }),
	options: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'Choice list. When provided, the user picks one or selects the automatically included "Other (type custom answer)..." option to type a custom free-text response. Omit for direct free-text input.',
		}),
	),
	placeholder: Type.Optional(
		Type.String({
			description:
				"Placeholder hint for free-text input (used both when options is omitted and when the user selects the custom free-text option).",
		}),
	),
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
		'Use options for choices (automatically includes an "Other (type custom answer)..." free-text fallback unless one is already present), or omit options for direct free-text input.',
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
		'When you need user input to proceed, call ask_user instead of stalling: one question per call, 2-4 options when choices are known ("Other (type custom answer)..." is added automatically so the user can always type a custom answer; do not add a duplicate "Other" option, and optionally set placeholder to hint custom input).',
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
		const { choices, customLabels } = prepareSelectOptions(options);
		try {
			return await withAskUserLock(async () => {
				const uiOptions = signal ? { signal } : undefined;
				if (choices.length > 0) {
					const picked = await ctx.ui.select(question, choices, uiOptions);
					if (picked === undefined) {
						return buildDismissedResult(question);
					}
					if (customLabels.has(picked)) {
						const customText = await ctx.ui.input(
							question,
							placeholder ?? DEFAULT_CUSTOM_INPUT_PLACEHOLDER,
							uiOptions,
						);
						if (customText === undefined || !customText.trim()) {
							return buildDismissedResult(question);
						}
						return buildAnsweredResult(customText);
					}
					return buildAnsweredResult(picked);
				}
				const text = await ctx.ui.input(question, placeholder, uiOptions);
				if (text === undefined) {
					return buildDismissedResult(question);
				}
				return buildAnsweredResult(text);
			});
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
