/**
 * Agent switch — persistence helpers.
 *
 * Persists the selected agent to the global `settings.json` as
 * `defaultAgent` (agent name string), so the next `pi` startup (or a new
 * session in the same process) restores it — mirroring
 * `model-memory/persist.ts` (`defaultProvider`/`defaultModel`).
 *
 * `reset` removes the key. All helpers never throw so event handlers
 * can't crash the session.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	resolveAgentDir,
	settingsPathFor,
} from "../model-memory/persist.ts";

export { resolveAgentDir, settingsPathFor };

export interface AgentPersistResult {
	ok: boolean;
	path: string;
	name: string | null;
	skipped?: string;
	error?: string;
}

/** Read the persisted default agent name. Returns null when absent/invalid. */
export function readPersistedAgent(agentDir: string): { name: string } | null {
	let raw: string;
	try {
		raw = fs.readFileSync(settingsPathFor(agentDir), "utf-8");
	} catch {
		// Missing/unreadable — no persisted choice.
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const value = (parsed as Record<string, unknown>).defaultAgent;
		if (typeof value !== "string") return null;
		const name = value.trim();
		return name ? { name } : null;
	} catch {
		// Corrupt JSON — fail to default, never throw.
		return null;
	}
}

/**
 * Persist (or clear, when `name` is null) the `defaultAgent` key in
 * settings.json. Preserves every other key. Atomic tmp+rename. Never
 * throws — returns `{ ok: false }` instead. No-op when unchanged.
 */
export function persistAgentAsDefault(
	agentDir: string,
	name: string | null,
): AgentPersistResult {
	const settingsPath = settingsPathFor(agentDir);

	const trimmed = name === null ? null : name.trim();
	if (name !== null && !trimmed) {
		return { ok: false, path: settingsPath, name, skipped: "empty agent name" };
	}

	let raw: string | undefined;
	try {
		raw = fs.readFileSync(settingsPath, "utf-8");
	} catch (error) {
		raw = undefined;
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			return {
				ok: false,
				path: settingsPath,
				name,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	let settings: Record<string, unknown> = {};
	if (raw !== undefined) {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				settings = parsed as Record<string, unknown>;
			} else {
				return { ok: false, path: settingsPath, name, skipped: "settings.json is not an object" };
			}
		} catch (error) {
			return {
				ok: false,
				path: settingsPath,
				name,
				error: `settings.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	const currentValue = settings.defaultAgent;
	if (trimmed === null) {
		if (!("defaultAgent" in settings)) {
			return { ok: true, path: settingsPath, name, skipped: "already cleared" };
		}
		const { defaultAgent: _removed, ...rest } = settings;
		void _removed;
		try {
			fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
			const tmp = `${settingsPath}.tmp.${process.pid}`;
			fs.writeFileSync(tmp, `${JSON.stringify(rest, null, 2)}\n`, "utf-8");
			fs.renameSync(tmp, settingsPath);
		} catch (error) {
			return {
				ok: false,
				path: settingsPath,
				name,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		return { ok: true, path: settingsPath, name };
	}

	if (currentValue === trimmed) {
		return { ok: true, path: settingsPath, name: trimmed, skipped: "already current" };
	}

	const next = { ...settings, defaultAgent: trimmed };
	try {
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		const tmp = `${settingsPath}.tmp.${process.pid}`;
		fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
		fs.renameSync(tmp, settingsPath);
	} catch (error) {
		return {
			ok: false,
			path: settingsPath,
			name: trimmed,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	return { ok: true, path: settingsPath, name: trimmed };
}
