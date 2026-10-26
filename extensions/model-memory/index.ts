/**
 * Model memory — remember the last selected model across restarts.
 *
 * Upstream `/model`: `Enter` / `/model <name>` / cycling only changes the
 * current session (`persist: false`). Only the explicit "set as default"
 * key persists to `settings.json`. This extension subscribes to the
 * `model_select` event (`set` + `cycle`) and writes
 * `defaultProvider`/`defaultModel` to the global settings file, so the
 * next `pi` launch boots with the last pick — no extra keypress needed.
 *
 * `restore` (startup rehydration) is ignored to avoid a write loop.
 * Failures warn once and never break the session.
 */

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	persistModelAsDefault,
	resolveAgentDir,
	shouldPersistSource,
} from "./persist.ts";

export default function (pi: ExtensionAPI) {
	pi.on("model_select", (event, ctx) => {
		try {
			if (!shouldPersistSource((event as { source?: string }).source)) return;
			const model = (event as { model?: { provider?: string; id?: string } }).model;
			const provider = model?.provider?.trim();
			const id = model?.id?.trim();
			if (!provider || !id) return;

			let agentDir: string;
			try {
				agentDir = getAgentDir();
			} catch {
				agentDir = resolveAgentDir(process.env);
			}

			const result = persistModelAsDefault(agentDir, provider, id);
			if (!result.ok && !result.skipped) {
				ctx.ui.notify(`Model memory: could not save default (${result.error})`, "warning");
			}
		} catch (error) {
			try {
				ctx.ui.notify(
					`Model memory: could not save default (${error instanceof Error ? error.message : String(error)})`,
					"warning",
				);
			} catch {
				// UI unavailable — never break the session for a memory write.
			}
		}
	});
}
