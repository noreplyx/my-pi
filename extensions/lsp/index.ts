/**
 * LSP extension: C#, Python, TypeScript/JavaScript via stdio language servers.
 * Factory only registers capabilities — no processes spawn until a tool
 * runs (or autoStart warms them on session_start).
 */
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findMissingBinaries, loadLspConfig, SUPPORTED_LANGUAGES, type SupportedLanguage } from "./config.js";
import { LspManager } from "./manager.js";
import { registerLspTools } from "./tools.js";

function extensionDir(): string {
	try {
		return path.dirname(fileURLToPath(import.meta.url));
	} catch {
		return process.cwd();
	}
}

function isSupportedLanguage(value: string): value is SupportedLanguage {
	return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

export default async function (pi: ExtensionAPI): Promise<void> {
	const dir = extensionDir();
	// Cwd is not final during factory; re-resolve on session_start.
	// Single manager + single tool registration (reload-safe; no spawn here).
	const initial = await loadLspConfig(dir, process.cwd());
	const manager = new LspManager(initial.config);
	if (initial.warnings.length > 0) console.warn(`LSP config warnings: ${initial.warnings.join("; ")}`);
	let cwd = process.cwd();

	registerLspTools(pi, manager, () => cwd);

	pi.registerCommand("lsp-status", {
		description: "Show LSP server status (language, root, running)",
		handler: async (_args, ctx) => {
				const rows = manager.status();
				const missing: string[] = [];
				for (const lang of SUPPORTED_LANGUAGES) {
					const s = manager.getConfig().servers[lang];
					if (!s.enabled) missing.push(`${lang}: disabled`);
				}
				for (const m of await findMissingBinaries(manager.getConfig())) {
					missing.push(`${m.lang}: ${m.hint}`);
				}
			const body =
				rows.length === 0
					? "LSP: no servers started (lazy start on first tool use)."
					: rows.map((r) => `${r.language} ${r.root} running=${r.running} diagnostics=${r.diagnosticUris}`).join("\n");
			const extra = missing.length > 0 ? `\n${missing.join("\n")}` : "";
			ctx.ui.notify(`${body}${extra}`, "info");
		},
	});

	pi.registerCommand("lsp-restart", {
		description: "Restart LSP servers: /lsp-restart [csharp|python|typescript]",
		handler: async (args, ctx) => {
			const lang = args.trim().toLowerCase();
			if (lang && !isSupportedLanguage(lang)) {
				ctx.ui.notify("Usage: /lsp-restart [csharp|python|typescript]", "warning");
				return;
			}
			await manager.restart(lang || undefined);
			ctx.ui.notify(lang ? `LSP restarted: ${lang}` : "LSP restarted: all servers", "info");
		},
	});

	pi.registerCommand("lsp-stop", {
		description: "Stop all LSP servers",
		handler: async (_args, ctx) => {
			await manager.stopAll();
			ctx.ui.notify("LSP servers stopped.", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		// Reload config now that cwd is authoritative. Stop stale servers;
		// tools close over `manager`/`cwd` so no re-registration is needed.
		const { config, sources, warnings } = await loadLspConfig(dir, cwd);
		await manager.stopAll().catch(() => undefined);
		manager.setConfig(config);
		if (ctx.mode === "tui") {
			ctx.ui.setStatus(
				"lsp",
				`LSP: ${SUPPORTED_LANGUAGES.filter((l) => config.servers[l].enabled).join(",") || "off"}`,
			);
		}
		if (sources.length > 0) {
			ctx.ui.notify(`LSP config: ${sources.join(", ")}`, "info");
		}
		for (const w of warnings) ctx.ui.notify(w, "warning");
		if (config.autoStart) {
			ctx.ui.notify("LSP autoStart is on — servers start on first tool use (lazy).", "info");
		}
	});

	pi.on("session_shutdown", async () => {
		// Idempotent; safe across quit/reload/fork converging here.
		await manager.stopAll().catch(() => undefined);
	});
}
