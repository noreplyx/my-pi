/**
 * Create-loop state machine (extension-enforced brainstorm → ask → confirm).
 *
 * Enforcement is param-based so it works without cross-tool spying:
 *  - `spec_create` with `confirm !== true` NEVER writes; it returns the
 *    brainstorm brief + instructions to run ask_user rounds first.
 *  - `spec_create` with `confirm === true` requires `askRounds >= 1` and a
 *    non-empty `answersSummary`. Otherwise it fails with guidance.
 *  - The model is instructed (tool description + /spec-create command) to
 *    call `ask_user` (when available) or ask in text, then echo the count
 *    and summary back in the confirming call.
 */

export interface BrainstormBrief {
	phase: "needs_input";
	message: string;
	suggestedQuestions: string[];
}

export function brainstormBrief(summary: string, kind: string): BrainstormBrief {
	const s = summary.trim() || "(no summary given)";
	return {
		phase: "needs_input",
		message: [
			`No file written yet. Brainstorm first, then ask the user.`,
			``,
			`Summary received: "${s}" (kind=${kind}).`,
			``,
			`Do ALL of the following before re-calling spec_create with confirm:true:`,
			`1. Restate the problem in your own words; list unknowns, constraints, affected areas (read the repo if it helps).`,
			`2. Ask the user questions via the ask_user tool (one question per call, batch independent ones in parallel).`,
			`   Keep looping until every open question is answered or explicitly deferred — never jump to a spec with gaps.`,
			`3. Present at least 2 solution options with pros/cons/risks and a recommendation; let the user choose.`,
			`4. Re-call spec_create with confirm:true, askRounds:<n>= Ask_user rounds you actually ran (>=1),`,
			`   answersSummary:"what the user decided", plus the full spec fields.`,
			`The confirming call is validated strictly (summary, explanation, acceptance, all 3 mermaid diagrams,`,
			`test cases, conditional HTTP/non-HTTP tables, pros/cons) and only then written to specs/<slug>.md.`,
		].join("\n"),
		suggestedQuestions: suggestedQuestions(kind),
	};
}

export function suggestedQuestions(kind: string): string[] {
	const base = [
		"Is this HTTP (request/response API) or non-HTTP (function/library)? Confirm the kind.",
		"Who calls this and what problem does it solve? (users, callers, scope)",
		"What are the acceptance criteria — how do we know it is done?",
		"Which options did you consider? (compare 2+ with pros/cons/risks)",
		"What test cases matter (happy path, errors, edge cases)?",
	];
	if (kind === "http" || kind === "mixed") {
		base.push("For each endpoint: case name, method, path, request shape, response shape?");
	}
	if (kind === "non-http" || kind === "mixed") {
		base.push("For each function: exact parameters and return values?");
	}
	base.push("Links to related specs or docs? (creates [[wikilinks]] in the Obsidian graph)");
	return base;
}

/** Validate the confirming call's loop receipt. Returns error text or null when OK. */
export function checkLoopReceipt(params: {
	confirm?: boolean;
	askRounds?: number;
	answersSummary?: string;
}): string | null {
	if (!params.confirm) return "confirm !== true";
	if (!params.askRounds || params.askRounds < 1) {
		return "askRounds must be >= 1: run at least one ask_user round (or text Q&A) before confirming, then pass the count.";
	}
	if (!params.answersSummary || !params.answersSummary.trim()) {
		return "answersSummary is required: summarize what the user decided during the ask loop.";
	}
	return null;
}

export const CREATE_INSTRUCTION = (summary: string) =>
	[
		`SPEC CREATE — summary: "${summary}".`,
		`1. Call spec_create with { slug, summary, kind } and confirm:false to get the brainstorm brief.`,
		`2. Brainstorm, then ask the user via ask_user (one question per call, parallel for independent ones). Loop until gaps close.`,
		`3. Present 2+ options with pros/cons/risks + recommendation; let the user pick.`,
		`4. Re-call spec_create with confirm:true, askRounds, answersSummary, and the complete spec fields.`,
		`Nothing is written until step 4 passes strict validation. Update specs/index.md automatically on write.`,
	].join("\n");
