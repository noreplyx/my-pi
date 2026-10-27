/**
 * Parent-side memoization for subagent-forwarded permission prompts (Option A).
 *
 * Problem: each `subagent` call spawns a fresh `pi --mode rpc --no-session`
 * child with its own empty in-memory `sessionGrants` store
 * (permissions/index.ts). When the child asks "Allow for this session" and
 * the user approves, the grant dies with the child process — the next child
 * prompts again for the identical call.
 *
 * Fix (v1, exact-title only): the parent remembers "Allow for this session"
 * answers keyed by agent + cwd + normalized dialog title. A repeated
 * identical permission dialog from a later child of the same agent is
 * auto-approved without re-prompting. "Session" here means the main session,
 * scoped per agent: agent A's approval never covers agent B, even for a
 * byte-identical title.
 *
 * Scope limits (intentional, documented):
 * - Exact-title match only. No sibling-directory coverage: `Allow write
 *   a/foo.txt?` does not cover `Allow write a/bar.txt?` (that needs the
 *   shared-file store of Option B with structured tool+path data).
 * - `Allow once`, `Deny`, dismissals are never cached (fail-closed).
 * - Legacy `confirm`-fallback permission dialogs are detected but never
 *   cached (a boolean cannot distinguish once vs session).
 * - `ask_user` uses the identical RPC wire shape; detection is heuristic
 *   (exact 3-option match + `Allow …?` title). A model-crafted ask_user
 *   with exactly those options and title would be misclassified on repeat
 *   — unlikely but nonzero; the structured-protocol fix (Option C) removes it.
 *
 * Pure + dependency-free (same convention as utils.ts) so it is unit-testable
 * with plain `bun test` outside the pi runtime.
 */

/** Must stay in sync with permissions/session-grants.ts SESSION_CHOICES. */
export const FORWARDED_SESSION_CHOICES = ["Allow once", "Allow for this session", "Deny"] as const;

export const FORWARDED_SESSION_VALUE = "Allow for this session";

/** Max cached grants; FIFO eviction of oldest. Titles are few; cap is a guard. */
export const MAX_FORWARDED_GRANTS = 500;

const PERMISSION_TITLE_RE = /^Allow .*?\?$/s;

export interface PermissionRequestShape {
	method?: unknown;
	title?: unknown;
	options?: unknown;
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((o) => typeof o === "string");
}

/**
 * True for a child permission `select` dialog: exactly the three session
 * choices + an `Allow …?` title. Uses the raw `req.options` (pre-filter).
 */
export function isPermissionSelect(req: PermissionRequestShape): boolean {
	if (req?.method !== "select") return false;
	if (typeof req.title !== "string" || !PERMISSION_TITLE_RE.test(req.title.trim())) return false;
	if (!isStringArray(req.options)) return false;
	const opts = req.options as string[];
	return (
		opts.length === FORWARDED_SESSION_CHOICES.length &&
		opts.every((o, i) => o === FORWARDED_SESSION_CHOICES[i])
	);
}

/** True for the legacy confirm-fallback permission dialog (detect-only, never cached). */
export function isPermissionConfirm(req: PermissionRequestShape): boolean {
	if (req?.method !== "confirm") return false;
	return typeof req.title === "string" && PERMISSION_TITLE_RE.test(req.title.trim());
}

/**
 * Normalize an agent name into a stable key segment. Agent lookup is
 * case-insensitive (single.ts matches on lowercase), so the key is too.
 */
export function normalizeAgentSegment(name: string): string {
	return name.trim().toLowerCase();
}

/**
 * Normalize a raw child dialog title into a stable key segment: trim and
 * collapse internal whitespace. Case is preserved (bash commands are
 * case-sensitive). Takes the raw child title (`req.title`, never
 * parent-prefixed) — callers compose the full key as
 * `agent\0cwd\0title`.
 */
export function normalizePermissionKey(rawTitle: string): string {
	return rawTitle.trim().replace(/\s+/g, " ");
}

export interface ForwardedPermissionStore {
	get(key: string): "session" | undefined;
	setSession(key: string): void;
	clear(): number;
	get size(): number;
}

export function createForwardedPermissionStore(limit = MAX_FORWARDED_GRANTS): ForwardedPermissionStore {
	const map = new Map<string, "session">();
	const cap = Math.max(1, Math.floor(limit) || MAX_FORWARDED_GRANTS);
	return {
		get(key: string) {
			return map.get(key);
		},
		setSession(key: string) {
			if (!key) return;
			if (map.has(key)) {
				map.delete(key); // re-insert to mark most-recent
			} else if (map.size >= cap) {
				const oldest = map.keys().next();
				if (!oldest.done) map.delete(oldest.value);
			}
			map.set(key, "session");
		},
		clear() {
			const n = map.size;
			map.clear();
			return n;
		},
		get size() {
			return map.size;
		},
	};
}
