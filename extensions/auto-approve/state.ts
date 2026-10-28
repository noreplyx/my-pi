/**
 * Auto-approve state — session-only toggle (default OFF, never persisted).
 *
 * IMPORTANT: the store is `process.env`, not a module-level variable. Each
 * extension file is loaded through its own jiti instance with
 * `moduleCache: false`, so a `let enabled` singleton would exist once per
 * importing extension (command, enforcer, and subagent propagator would each
 * see a different value). `process.env` is per-process — shared by every
 * extension in the same `pi` process — and is also the channel that carries
 * the toggle into child `pi` processes (set per-spawn by subagent/single.ts,
 * never from repo-controlled config).
 *
 * Pure module with no `pi` dependency so the `auto-approve` extension (owner
 * of the toggle + command), the `permissions` extension (enforcer that
 * short-circuits `ask` → allow), and the `subagent` extension (propagates
 * the toggle to child `pi` processes) can share it without import cycles.
 *
 * Session-only by design: enabling auto-approve must be a conscious,
 * per-session opt-in. The extension clears it on `session_start` (any
 * reason, unless inherited from a parent) and `session_shutdown`.
 */

/** Env var carrying the toggle (in-process store + subagent handoff). */
export const AUTO_APPROVE_ENV = "PI_AUTO_APPROVE";

/** True when the process inherited auto-approve from its parent env. */
export function isAutoApproveEnvSet(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[AUTO_APPROVE_ENV] === "1";
}

/** True when auto-approve is currently ON (ask prompts auto-allow). */
export function isAutoApproveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[AUTO_APPROVE_ENV] === "1";
}

/** Set the toggle explicitly. Returns the new value. */
export function setAutoApprove(value: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
	if (value) env[AUTO_APPROVE_ENV] = "1";
	else delete env[AUTO_APPROVE_ENV];
	return value;
}

/** Reset to OFF. Returns the number cleared (0 or 1, mirrors sessionGrants.clear()). */
export function clearAutoApprove(env: NodeJS.ProcessEnv = process.env): number {
	const n = env[AUTO_APPROVE_ENV] === "1" ? 1 : 0;
	delete env[AUTO_APPROVE_ENV];
	return n;
}

export type AutoApproveArg = "on" | "off" | "status" | "invalid";

/**
 * Parse `/auto-approve` args. Accepts on/enable and off/disable aliases;
 * empty string means status. Pure — safe to unit-test without `pi`.
 */
export function parseAutoApproveArg(raw: unknown): AutoApproveArg {
	const text = String(raw ?? "").trim().toLowerCase();
	if (text === "") return "status";
	if (text === "on" || text === "enable" || text === "enabled" || text === "1" || text === "true") return "on";
	if (text === "off" || text === "disable" || text === "disabled" || text === "0" || text === "false") return "off";
	if (text === "status" || text === "state" || text === "show") return "status";
	return "invalid";
}
