// Choice: what an answer is and the one message the user sends. Pure logic, no pi imports.
// A click stages an answer; nothing is sent until the user presses Send answers (and confirms), and then every Choice of the
// widget goes in ONE message.
import type { El } from "../lang/library.ts";
import { LIMITS } from "../lang/library.ts";
import { createNullMap, isSafeKey, neutralizePrompt, runsAsCommand } from "../security.ts";
import { clip, collapse, quiet } from "./notes.ts";

export { runsAsCommand };
export const NO_ANSWER = "(no answer)";

/** A question as the board knows it. `question` and `options` are the cleaned words the message uses. */
export interface Choice {
	question: string;
	options: string[];
	multiple: boolean;
	other: boolean;
	/** a fingerprint of the words and the two flags: Choices with one key are ONE question, they share their answer and count once */
	key: string;
}

/** What the user has staged for one question. `picks` are option indexes, ascending. `other` is the Other row being selected. */
export interface Answer {
	picks: number[];
	other: boolean;
	text: string;
}
export type Answers = Record<string, Answer>;

const BLANK: Answer = { picks: [], other: false, text: "" };
const cur = (a: Answers, c: Choice): Answer => (isSafeKey(c.key) && a[c.key] ? a[c.key] : BLANK);
const word = (raw: unknown, max: number): string => clip(neutralizePrompt(collapse(raw), { allowNewlines: false, prefixCommand: "" }), max);

function cloneAnswers(a: Answers): Answers {
	const out = createNullMap<Answer>();
	for (const [k, v] of Object.entries(a ?? {})) {
		if (isSafeKey(k)) out[k] = v;
	}
	return out;
}

export function makeChoice(props: Record<string, any>): Choice {
	const options = (Array.isArray(props?.options) ? props.options : []).map((o: unknown) => word(o, LIMITS.option));
	const question = word(props?.question, LIMITS.question);
	const multiple = props?.multiple === true;
	const other = props?.other !== false;
	return { question, options, multiple, other, key: JSON.stringify([question, options, multiple, other]) };
}

/** Every Choice of a compiled tree in document order, whether or not its tab was ever shown. Identical questions are merged. */
export function collectChoices(root: El | undefined): Choice[] {
	const out: Choice[] = [];
	const keys = new Set<string>();
	const seen = new Set<object>();
	const walk = (x: unknown) => {
		if (!x || typeof x !== "object" || seen.has(x)) return;
		seen.add(x);
		if (Array.isArray(x)) return x.forEach(walk);
		const el = x as El;
		if (el.type === "Choice") {
			const c = makeChoice(el.props);
			if (!keys.has(c.key)) {
				keys.add(c.key);
				out.push(c);
			}
			return;
		}
		if (el.props && typeof el.props === "object") for (const v of Object.values(el.props)) walk(v);
	};
	walk(root);
	return out;
}

// ---------- the answers (every function returns new null-prototype objects) ----------

/** The user's own text, tidied: a tab is a space, trailing blanks and control characters go, a run of blank lines is one blank line, and @file / /command tokens are neutralized. */
function tidyOther(raw: unknown): string {
	return neutralizePrompt(raw == null ? "" : String(raw).replace(/\t/g, " "), { allowNewlines: true, prefixCommand: "" })
		.split("\n")
		.map((l) => l.replace(/[ \t]+$/g, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * The user's own text as it is kept and sent: newlines stay (a run of blank lines is one, so a message cannot be padded), a tab is
 * a space, trailing blanks and control characters go, at most LIMITS.other characters, and @file / /command tokens are neutralized.
 */
export function cleanOther(raw: unknown): string {
	return Array.from(tidyOther(raw)).slice(0, LIMITS.other).join("");
}

/** How long the text is once tidied and before the cut, so "shortened" is said only when something is cut. */
export const otherLength = (raw: unknown): number => Array.from(tidyOther(raw)).length;

export function toggleOption(a: Answers, c: Choice, i: number): Answers {
	if (!Number.isInteger(i) || i < 0 || i >= c.options.length || !isSafeKey(c.key)) return a;
	const now = cur(a, c);
	let next: Answer;
	if (c.multiple) next = { ...now, picks: now.picks.includes(i) ? now.picks.filter((x) => x !== i) : [...now.picks, i].sort((x, y) => x - y) };
	else next = now.picks.length === 1 && now.picks[0] === i ? { ...now, picks: [] } : { ...now, picks: [i], other: false };
	const out = cloneAnswers(a);
	out[c.key] = next;
	return out;
}

/** The user saved their own answer. Text selects the Other row (single mode: it replaces the option); empty text unselects it. */
export function setOther(a: Answers, c: Choice, text: string): Answers {
	if (!c.other || !isSafeKey(c.key)) return a;
	const clean = cleanOther(text);
	const now = cur(a, c);
	const out = cloneAnswers(a);
	if (!clean) {
		out[c.key] = { ...now, other: false, text: "" };
		return out;
	}
	out[c.key] = { picks: c.multiple ? now.picks : [], other: true, text: clean };
	return out;
}

const otherOf = (c: Choice, a: Answer): string => (c.other && a.other ? cleanOther(a.text) : "");

/** An Other row that is selected but empty is not an answer. */
export function isAnswered(c: Choice, a: Answers): boolean {
	const now = cur(a, c);
	return now.picks.some((i) => i >= 0 && i < c.options.length) || otherOf(c, now) !== "";
}

export function progress(cs: Choice[], a: Answers): { answered: number; total: number } {
	return { answered: cs.filter((c) => isAnswered(c, a)).length, total: cs.length };
}

/** `disk; memory; other: also look at the logs`, or "" when not answered. A second line of Other text is indented under the question. */
export function answerWords(c: Choice, a: Answers): string {
	const now = cur(a, c);
	const parts = now.picks.filter((i) => i >= 0 && i < c.options.length).map((i) => c.options[i]);
	const text = otherOf(c, now);
	if (text) parts.push("other: " + text.split("\n").join("\n   "));
	return parts.join("; ");
}

// ---------- the message ----------

export function buildMessage(cs: Choice[], a: Answers, title: string): string {
	if (cs.length === 1 && !cs[0].multiple) {
		const c = cs[0];
		const now = cur(a, c);
		if (now.picks.length === 1 && c.options[now.picks[0]] !== undefined && !otherOf(c, now)) {
			const line = `${c.question} \u2014 ${c.options[now.picks[0]]}`;
			if (!runsAsCommand(line)) return line;
		}
	}
	const name = title ? quiet(title, 60) : "";
	const head = name ? `Answers to the questions in widget \`${name}\` (${cs.length}):` : `Answers to the questions in this widget (${cs.length}):`;
	const lines = cs.map((c, i) => `${i + 1}. ${c.question}\n   ${answerWords(c, a) || NO_ANSWER}`);
	return `${head}\n\n${lines.join("\n")}`;
}
