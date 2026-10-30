/**
 * Session-scoped permission grants (in-memory only, never persisted).
 *
 * Two grant kinds:
 * - exact: one `tool + primary target` pair (used for bash and non-path
 *   tools, and as a fallback everywhere).
 * - directory: one `tool + absolute directory` pair (file tools only).
 *   A directory grant covers the directory itself, files directly inside
 *   it, and everything under subdirectories (recursive downward). It never
 *   covers the parent — matching only goes down.
 *
 * Pure helpers + a tiny store so the logic is unit-testable without `pi`.
 * Directory inputs are expected pre-normalized (absolute, no trailing
 * separator — see `normalizeDir` in loader.ts); matching normalizes
 * defensively anyway.
 */

import * as path from "node:path";

export const SESSION_CHOICE_ONCE = "Allow once";
export const SESSION_CHOICE_SESSION = "Allow for this session";
export const SESSION_CHOICE_DENY = "Deny";
export const SESSION_CHOICE_DENY_FEEDBACK = "Deny with feedback";

export const SESSION_CHOICES = [SESSION_CHOICE_ONCE, SESSION_CHOICE_SESSION, SESSION_CHOICE_DENY, SESSION_CHOICE_DENY_FEEDBACK] as const;
export type SessionChoice = (typeof SESSION_CHOICES)[number];

/** Stable key for one exact tool + primary target pair. */
export function grantKey(toolName: string, primaryTarget: string): string {
	return `${toolName}\0${primaryTarget}`;
}

/** Defensive absolute-path normalization (absolute, no trailing separator). */
function normalizeAbs(p: string): string {
	const norm = path.normalize(p);
	if (norm.length > 1 && norm.endsWith(path.sep)) return norm.slice(0, -path.sep.length);
	return norm;
}

function dirPrefix(dir: string): string {
	return dir.endsWith(path.sep) ? dir : dir + path.sep;
}

export interface SessionGrant {
	tool: string;
	/** Exact primary target, or the absolute directory for directory grants. */
	target: string;
	scope: "exact" | "directory";
	/** Which rule/default triggered the ask (for status display). */
	where: string;
	grantedAt: string;
}

export function createSessionGrants() {
	const exact = new Map<string, SessionGrant>();
	// tool name -> granted dir -> grant (recursive downward matching)
	const byDir = new Map<string, Map<string, SessionGrant>>();

	return {
		has(toolName: string, primaryTarget: string): SessionGrant | undefined {
			return exact.get(grantKey(toolName, primaryTarget));
		},
		add(toolName: string, primaryTarget: string, where: string): SessionGrant {
			const grant: SessionGrant = {
				tool: toolName,
				target: primaryTarget,
				scope: "exact",
				where,
				grantedAt: new Date().toISOString(),
			};
			exact.set(grantKey(toolName, primaryTarget), grant);
			return grant;
		},
		/**
		 * True when a directory grant covers this absolute file/dir path:
		 * the path is the granted dir itself, directly inside it, or under
		 * a subdirectory. Never matches the parent (downward only).
		 */
		hasDirectory(toolName: string, absPath: string): SessionGrant | undefined {
			const dirs = byDir.get(toolName);
			if (!dirs || dirs.size === 0) return undefined;
			const normP = normalizeAbs(absPath);
			const parent = path.dirname(normP);
			for (const [dir, grant] of dirs) {
				if (normP === dir || parent === dir || parent.startsWith(dirPrefix(dir))) return grant;
			}
			return undefined;
		},
		addDirectory(toolName: string, absDir: string, where: string): SessionGrant {
			const dir = normalizeAbs(absDir);
			const grant: SessionGrant = { tool: toolName, target: dir, scope: "directory", where, grantedAt: new Date().toISOString() };
			let dirs = byDir.get(toolName);
			if (!dirs) {
				dirs = new Map();
				byDir.set(toolName, dirs);
			}
			dirs.set(dir, grant);
			return grant;
		},
		clear(): number {
			let n = exact.size;
			for (const dirs of byDir.values()) n += dirs.size;
			exact.clear();
			byDir.clear();
			return n;
		},
		list(): SessionGrant[] {
			const out = [...exact.values()];
			for (const dirs of byDir.values()) out.push(...dirs.values());
			return out;
		},
		get size(): number {
			let n = exact.size;
			for (const dirs of byDir.values()) n += dirs.size;
			return n;
		},
	};
}

export type SessionGrants = ReturnType<typeof createSessionGrants>;
