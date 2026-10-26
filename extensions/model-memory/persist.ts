/**
 * Model memory — persistence helpers.
 *
 * Writes the last selected model to the global `settings.json` as
 * `defaultProvider`/`defaultModel`, so the next `pi` startup boots with it.
 * Upstream pi only persists on explicit "set as default" (`persist: true`);
 * plain picks (`Enter`, `/model <name>`, cycling) are session-only.
 * This extension closes that gap by persisting every `model_select`
 * except `restore` (startup rehydration).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ModelSelectSource = "set" | "cycle" | "restore" | (string & {});

/** `restore` is startup rehydration — persisting it would be a no-op loop. */
export function shouldPersistSource(source: string | undefined): boolean {
	return source !== "restore";
}

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const override =
		env.PI_CODING_AGENT_DIR ?? env.PI_AGENT_DIR ?? env.AGENT_DIR;
	if (override && override.trim()) {
		const expanded =
			override.startsWith("~/") || override === "~"
				? path.join(os.homedir(), override.slice(2))
				: override;
		return path.resolve(expanded);
	}
	return path.join(os.homedir(), ".pi", "agent");
}

export function settingsPathFor(agentDir: string): string {
	return path.join(agentDir, "settings.json");
}

export interface PersistResult {
	ok: boolean;
	path: string;
	provider: string;
	id: string;
	skipped?: string;
	error?: string;
}

/**
 * Atomically update `defaultProvider`/`defaultModel` in settings.json.
 * Preserves every other key. Never throws — returns `{ ok: false }` instead
 * so event handlers can't crash the session.
 */
export function persistModelAsDefault(
	agentDir: string,
	provider: string,
	id: string,
): PersistResult {
	const settingsPath = settingsPathFor(agentDir);
	if (!provider || !id) {
		return { ok: false, path: settingsPath, provider, id, skipped: "empty provider/id" };
	}

	let raw: string | undefined;
	try {
		raw = fs.readFileSync(settingsPath, "utf-8");
	} catch (error) {
		// No settings file yet — create a minimal one rather than failing.
		raw = undefined;
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			return {
				ok: false,
				path: settingsPath,
				provider,
				id,
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
				return { ok: false, path: settingsPath, provider, id, skipped: "settings.json is not an object" };
			}
		} catch (error) {
			return {
				ok: false,
				path: settingsPath,
				provider,
				id,
				error: `settings.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	if (settings.defaultProvider === provider && settings.defaultModel === id) {
		return { ok: true, path: settingsPath, provider, id, skipped: "already current" };
	}

	const next = { ...settings, defaultProvider: provider, defaultModel: id };

	try {
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		const tmp = `${settingsPath}.tmp.${process.pid}`;
		fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
		fs.renameSync(tmp, settingsPath);
	} catch (error) {
		return {
			ok: false,
			path: settingsPath,
			provider,
			id,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	return { ok: true, path: settingsPath, provider, id };
}
