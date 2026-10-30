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

/** Per-run FIFO mutex: parallel / swarm workers queue questions one at a time.
 * Single-mode reuses the global lock (legacy `withQuestionLock`). Parallel /
 * swarm runs construct their own lock via `createQuestionLock()` so queues
 * never leak across runs. `notify` and other fire-and-forget methods never
 * enter the lock.
 */
export interface QuestionQueueStats {
	/** Number of question handlers queued or holding the lock. */
	depth: number;
	/** Ms the oldest queued waiter has been waiting (0 when empty). */
	oldestWaitMs: number;
}

export type QuestionLockFn = <T>(fn: () => Promise<T>) => Promise<T>;

export type QuestionLock = QuestionLockFn & { getStats(): QuestionQueueStats };

function makeQuestionLock(): QuestionLock {
	let tail: Promise<void> = Promise.resolve();
	let enqueuedAt: number[] = [];
	const run = (<T>(fn: () => Promise<T>): Promise<T> => {
		const started = Date.now();
		enqueuedAt.push(started);
		if (enqueuedAt.length > 1) {
			try {
				console.debug(`[subagent] question queued depth=${enqueuedAt.length}`);
			} catch {
				/* never break the child on logging */
			}
		}
		const prev = tail;
		let release!: () => void;
		const current = new Promise<void>((r) => {
			release = r;
		});
		tail = current;
		const dequeue = () => {
			const idx = enqueuedAt.indexOf(started);
			if (idx >= 0) enqueuedAt.splice(idx, 1);
		};
		return prev.then(fn).finally(() => {
			dequeue();
			release();
		});
	}) as QuestionLock;
	run.getStats = (): QuestionQueueStats => {
		if (enqueuedAt.length === 0) return { depth: 0, oldestWaitMs: 0 };
		return { depth: enqueuedAt.length, oldestWaitMs: Date.now() - Math.min(...enqueuedAt) };
	};
	return run;
}

/** Create an isolated per-run question lock (parallel / swarm). No default timeout. */
export function createQuestionLock(): QuestionLock {
	return makeQuestionLock();
}

const globalQuestionLock = makeQuestionLock();

/** Legacy global lock (single-mode). Prefer `createQuestionLock()` for parallel/swarm runs. */
export function withQuestionLock<T>(fn: () => Promise<T>): Promise<T> {
	return globalQuestionLock(fn);
}

/** Queue stats for the legacy global lock. */
export function getQuestionQueueStats(): QuestionQueueStats {
	return globalQuestionLock.getStats();
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
