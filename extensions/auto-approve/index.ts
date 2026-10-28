/**
 * Auto-approve — session-only toggle that auto-allows permission `ask` prompts.
 *
 * - `/auto-approve on` — auto-allow every `ask` (no dialogs). Explicit `deny`
 *   rules still block (fail-closed); the toggle never bypasses `deny`.
 * - `/auto-approve off` — back to prompting (default).
 * - `/auto-approve` or `/auto-approve status` — show current state.
 *
 * State lives in `state.ts` (shared, pi-free). Enforcement happens in the
 * `permissions` extension's `tool_call` handler, which checks
 * `isAutoApproveEnabled()` after the `deny` branch and before any dialog.
 * This extension owns the toggle, the command, and the status-bar indicator.
 *
 * Safety: default OFF, stored in process env (per-process, never written
 * to disk), cleared on `session_start` (any reason) and `session_shutdown`
 * — except when the process inherited PI_AUTO_APPROVE=1 from a parent
 * (subagent child): then the toggle stays ON so delegated work doesn't
 * re-prompt. Subagent children of an auto-approving parent inherit
 * automatically; `deny` rules still block everywhere. Headless runs
 * (`--mode json`, no UI) are also auto-allowed when ON, so prefer OFF
 * for unattended runs unless you accept the risk.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearAutoApprove, isAutoApproveEnabled, isAutoApproveEnvSet, parseAutoApproveArg, setAutoApprove } from "./state.ts";

const STATUS_KEY = "auto-approve";

function statusText(ctx: Pick<ExtensionContext, "ui">): void {
	try {
		ctx.ui.setStatus(STATUS_KEY, isAutoApproveEnabled() ? "auto-approve:ON" : undefined);
	} catch {
		// Status bar is TUI-only; never break the toggle on it.
	}
}

function usage(): string {
	return "Usage: /auto-approve [on|off|status] — on = auto-allow ask prompts (deny still blocks), off = prompt again (default), no arg = status.";
}

export default function (pi: ExtensionAPI) {
	// New session starts clean: a previous session's ON must never leak in —
	// unless this process inherited PI_AUTO_APPROVE=1 from a parent (subagent
	// child): then the toggle stays ON so delegated work doesn't re-prompt.
	// (session_start covers startup/reload/new/resume/fork — all reset.)
	// The parent shell never sets this var (it is only placed in the child's
	// spawn env), so main-session behavior is unchanged.
	pi.on("session_start", (_event, ctx) => {
		if (isAutoApproveEnvSet()) setAutoApprove(true);
		else clearAutoApprove();
		statusText(ctx);
	});

	// Idempotent cleanup: a follow-on session in the same process must never
	// inherit a stale ON.
	pi.on("session_shutdown", (_event, ctx) => {
		clearAutoApprove();
		statusText(ctx);
	});

	pi.registerCommand("auto-approve", {
		description: "Toggle session-only auto-approve: /auto-approve [on|off|status] (ask→allow, deny still blocks)",
		handler: async (args, ctx) => {
			const parsed = parseAutoApproveArg(args);
			if (parsed === "invalid") {
				ctx.ui.notify(`Unknown argument: ${JSON.stringify(String(args ?? "").trim().slice(0, 40))}.\n${usage()}`, "warning");
				return;
			}
			if (parsed === "status") {
				const on = isAutoApproveEnabled();
				ctx.ui.notify(
					on
						? "Auto-approve is ON — ask prompts are auto-allowed (deny rules still block). Session-only; resets on reload/shutdown."
						: `Auto-approve is OFF — ask prompts show a dialog (default).\n${usage()}`,
					"info",
				);
				return;
			}
			const on = parsed === "on";
			setAutoApprove(on);
			statusText(ctx);
			ctx.ui.notify(
				on
					? "Auto-approve ON — ask prompts are auto-allowed (deny rules still block). Session-only; /auto-approve off to restore prompts."
					: "Auto-approve OFF — ask prompts will show a dialog again.",
				on ? "warning" : "info",
			);
		},
	});
}
