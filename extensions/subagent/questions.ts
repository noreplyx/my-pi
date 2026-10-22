/**
 * Shared parent-UI bridge for subagent question forwarding (Option C).
 *
 * The child `pi --mode rpc` process emits `extension_ui_request` lines on
 * stdout. The parent (this extension) forwards `select` / `confirm` /
 * `input` to its own `ctx.ui` under a global mutex so parallel / swarm
 * workers never overlap dialogs, then writes `extension_ui_response`
 * back to the child's stdin.
 */

export interface ParentUI {
	hasUI: boolean;
	select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
	confirm(title: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
	input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** Global FIFO mutex: parallel / swarm workers queue questions one at a time. */
let questionQueue: Promise<void> = Promise.resolve();

export function withQuestionLock<T>(fn: () => Promise<T>): Promise<T> {
	const prev = questionQueue;
	let release!: () => void;
	const current = new Promise<void>((r) => {
		release = r;
	});
	questionQueue = current;
	return prev.then(fn).finally(() => release());
}

/** Methods that are fire-and-forget in RPC mode (child never waits). */
const FIRE_AND_FORGET = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);

/** Methods we forward in the first cut. `editor` / `custom` are rejected visibly. */
const FORWARDED = new Set(["select", "confirm", "input"]);

export function isFireAndForgetMethod(method: string): boolean {
	return FIRE_AND_FORGET.has(method);
}

export function isForwardedMethod(method: string): boolean {
	return FORWARDED.has(method);
}

export interface ForwardResult {
	/** JSON object to write back to child stdin, or null for fire-and-forget. */
	response: Record<string, unknown> | null;
	/** Human-readable note for stderr when the request was not forwarded. */
	note?: string;
	/** Mirror notification for the parent UI (fire-and-forget methods). */
	notify?: { message: string; type: "info" | "warning" | "error" };
}

/**
 * Pure decision function (unit-testable, no I/O): given a child's
 * `extension_ui_request`, decide what to ask the parent UI and what to
 * send back when there is no UI or the method is unsupported.
 */
export function decideQuestionResponse(
	req: { id: string; method: string; title?: string; message?: string },
	opts: { hasUI: boolean; allowQuestions: boolean },
): ForwardResult {
	const { id, method } = req;
	if (FIRE_AND_FORGET.has(method)) {
		return { response: null };
	}
	if (!FORWARDED.has(method)) {
		return {
			response: { type: "extension_ui_response", id, cancelled: true },
			note: `[question skipped: unsupported method "${method}"]`,
		};
	}
	if (!opts.hasUI || !opts.allowQuestions) {
		const reason = !opts.hasUI ? "no UI to confirm in" : "questions disabled for this task";
		if (method === "confirm") {
			return {
				response: { type: "extension_ui_response", id, confirmed: false },
				note: `[question skipped (${reason}): ${req.title ?? method}]`,
			};
		}
		return {
			response: { type: "extension_ui_response", id, cancelled: true },
			note: `[question skipped (${reason}): ${req.title ?? method}]`,
		};
	}
	// Needs live parent UI — caller performs ctx.ui call under the mutex.
	return { response: null };
}
