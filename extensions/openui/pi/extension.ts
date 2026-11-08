// pi extension: render_widget (OpenUI Lang -> interactive terminal widget) plus slash commands.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Type } from "typebox";
import { compile, LIMITS, reference, type Compiled, type El } from "../lang/library.ts";
import { markdownImages } from "../lang/md.ts";
import { LANG_SAMPLES } from "../lang/samples.ts";
import { neutralizePrompt, resolveWorkspaceFilePath, stripControl } from "../security.ts";
import { imageService, loadImage } from "./images.ts";
import { active, armNewest, confirmDelivery, entryOf, handleKey, hooks, OpenUIWidget, resetAll, toggleNotesNewest } from "./widget.ts";
import { syncWidths } from "./widths.ts";

let currentCwd = process.cwd();

const compiled = new Map<string, Compiled>();
let compiledChars = 0;
const CACHE_CHARS = 2_000_000;

export function compileCached(source: string): Compiled {
	if (source.length > LIMITS.source) return compile(source);
	const hit = compiled.get(source);
	if (hit) {
		compiled.delete(source);
		compiled.set(source, hit);
		return hit;
	}
	const c = compile(source);
	while (compiled.size >= 64 || (compiled.size > 0 && compiledChars + source.length > CACHE_CHARS)) {
		const oldest = compiled.keys().next().value;
		if (oldest === undefined) break;
		compiled.delete(oldest);
		compiledChars -= oldest.length;
	}
	compiled.set(source, c);
	compiledChars += source.length;
	return c;
}

/** A picture the widget will draw: an Image component, or a `![alt](path)` line in a Markdown or an FAQ answer. */
export interface Picture {
	src: string;
	line: number;
	via: "Image" | "Markdown picture";
}

/** Every picture in a compiled tree, wherever it was written. */
export function picturesIn(el: El | undefined, out: Picture[] = []): Picture[] {
	if (!el || typeof el !== "object") return out;
	if (el.type === "Image") out.push({ src: String(el.props.src ?? ""), line: el.line, via: "Image" });
	const text = el.type === "Markdown" ? el.props.text : el.type === "FaqItem" ? el.props.answer : undefined;
	if (text !== undefined) for (const m of markdownImages(text)) out.push({ src: m.src, line: el.line, via: "Markdown picture" });
	for (const v of Object.values(el.props ?? {}))
		for (const x of Array.isArray(v) ? v : [v])
			if (Array.isArray(x)) continue;
			else if (x && typeof x === "object" && "type" in x && "props" in x) picturesIn(x as El, out);
	return out;
}

/** Problems the model can fix: the picture must exist inside the workspace and be a format a terminal can show. */
export function checkImages(root: El | undefined, cwd: string = currentCwd): string[] {
	const errs: string[] = [];
	for (const im of picturesIn(root)) {
		const r = loadImage(im.src, cwd);
		if ("error" in r) {
			const cleanSrc = stripControl(im.src, false);
			const shown = cleanSrc.startsWith("data:") ? "data: URI" : `"${cleanSrc.length > 80 ? cleanSrc.slice(0, 77) + "..." : cleanSrc}"`;
			errs.push(`line ${im.line}: ${im.via} ${shown}: ${stripControl(r.error, false)}`);
		}
	}
	return errs;
}

export default function (pi: ExtensionAPI) {
	syncWidths();
	hooks.sendLive = (text) => pi.sendUserMessage(neutralizePrompt(text, { allowNewlines: true, prefixCommand: "[Widget action] " }), { deliverAs: "followUp" });
	hooks.sendEcho = (text) => pi.sendMessage({ customType: "openui-click", content: `[widget click → assistant] ${stripControl(text, false)}`, display: true });

	pi.registerTool({
		name: "render_widget",
		label: "render_widget",
		description:
			"Draw an interactive widget in the terminal: dashboards, tables, charts (bar, line, area, pie, radar), diagrams (DAG, ER, infrastructure map, sequence), maps, tabs, buttons and choices. Pass OpenUI Lang as `source`. Call with reference=true once to get the component signatures. A Button click sends its text back to you as the user's next message (after user confirmation). Choice answers are staged and arrive together as one message when the user presses Send answers.",
		promptSnippet: "render_widget: draw an interactive terminal widget (dashboards, charts, diagrams) from OpenUI Lang",
		promptGuidelines: [
			"Prefer render_widget over long Markdown tables, lists, or ASCII diagrams whenever presenting execution plans, specifications, architecture/dependency graphs (Dag, Erd, InfraMap, SequenceDiagram), code review findings, test matrices, database/ADO query results, or multi-section reports (Tabs/Card).",
			"Before the first render_widget call in a session, call render_widget with reference=true to read the component signatures. Never guess a signature.",
			"After render_widget succeeds, reply with at most one short sentence. Do not repeat the widget's data in prose.",
			"If render_widget returns errors, fix exactly the errors listed and call it again with the full corrected source.",
			"Use plain text, not a widget, for a single value or a short answer. One widget per reply: use Tabs or Card to organise sections.",
			"A Button click arrives as your next user message: act on it, then render a NEW widget if needed. Choice answers arrive together as ONE message after the user presses Send answers, so ask all your questions in one widget (a Card or Tabs), then act on the answers.",
		],
		parameters: Type.Object({
			source: Type.Optional(Type.String({ description: "OpenUI Lang source: root = Stack([...]) first, one statement per line" })),
			reference: Type.Optional(Type.Boolean({ description: "Return the component reference instead of drawing" })),
		}),
		renderShell: "self",
		async execute(_id: string, params: { source?: string; reference?: boolean }, _signal?: AbortSignal, _onUpdate?: any, ctx?: any) {
			if (params.reference || params.source === undefined) return { content: [{ type: "text" as const, text: reference() }], details: { kind: "reference" } };
			const cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : currentCwd;
			currentCwd = cwd;
			imageService.setCwd(cwd);
			const c = compileCached(params.source);
			if (!c.ok) throw new Error(`The widget was not drawn: ${c.errors.length} error(s). Fix these and call render_widget again with the full corrected source.\n${c.errors.map((e) => `- ${e}`).join("\n")}`);
			const imgErrs = checkImages(c.root, cwd);
			if (imgErrs.length) throw new Error(`The widget was not drawn: ${imgErrs.length} error(s). Fix these and call render_widget again with the full corrected source.\n${imgErrs.map((e) => `- ${e}`).join("\n")}`);
			const hasImage = picturesIn(c.root).length > 0;
			const noPics = hasImage && getCapabilities().images !== "kitty";
			const note = [...c.warnings, ...(noPics ? ["this terminal cannot show pictures, so each Image is drawn as a labelled frame with its file details"] : [])];
			const noteText = note.length ? ` Notes: ${note.join("; ")}.` : "";
			return { content: [{ type: "text" as const, text: `Widget drawn. The user can see and click it in the terminal; do not repeat its contents.${noteText}` }], details: { kind: "widget", source: params.source } };
		},
		renderCall(args: any, theme: any) {
			const n = typeof args?.source === "string" ? args.source.split("\n").length : 0;
			const label = args?.reference ? "reference" : n ? `${n} lines of OpenUI` : "…";
			return new Text(theme.fg("toolTitle", theme.bold("render_widget")) + theme.fg("dim", ` ${label}`), 0, 0);
		},
		renderResult(result: any, _opts: any, theme: any, ctx: any) {
			if (ctx.isError) {
				const lines = String(result?.content?.[0]?.text ?? "failed")
					.split("\n")
					.slice(0, 9)
					.map((l) => stripControl(l, false));
				return new Text(lines.map((l) => theme.fg("error", l)).join("\n"), 0, 0);
			}
			if (result?.details?.kind !== "widget") return new Text(theme.fg("dim", "component reference loaded"), 0, 0);
			const c = compileCached(String(result.details.source ?? ""));
			if (!c.ok || !c.root) return new Text(theme.fg("error", "widget could not be restored"), 0, 0);
			return new OpenUIWidget(ctx.toolCallId, c.root, theme, "live");
		},
	});

	pi.registerMessageRenderer("openui-widget", (message: any, _o: any, theme: any) => {
		const c = compileCached(String(message.details?.source ?? ""));
		if (!c.ok || !c.root) return undefined;
		return new OpenUIWidget(String(message.details.id), c.root, theme, message.details.mode === "live" ? "live" : "echo");
	});

	const draw = (source: string, title: string, ctx: any) => {
		const c = compileCached(source);
		if (!c.ok) return ctx.ui.notify(`${stripControl(title, false)}: ${c.errors.slice(0, 3).join(" | ")}`, "error");
		pi.sendMessage({ customType: "openui-widget", content: `[widget: ${stripControl(title, false)}]`, display: true, details: { id: `w-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, source, mode: "echo" } });
	};

	pi.registerCommand("openui-gallery", {
		description: "Draw one example per OpenUI component (or a key prefix: dashboard, table, tabs, choice, line, pie, radar, image, dag, erd, infra, sequence, geo ...). Clicks echo locally.",
		handler: async (args: string, ctx: any) => {
			const which = stripControl(args, false).trim() || "all";
			const picked = LANG_SAMPLES.filter((s) => which === "all" || s.key.startsWith(which));
			if (!picked.length) return ctx.ui.notify(`unknown example "${which}". Try: all, ${LANG_SAMPLES.map((s) => s.key).join(", ")}`, "warning");
			for (const s of picked) draw(s.source, s.title, ctx);
		},
	});

	pi.registerCommand("openui-file", {
		description: "Draw a widget from an OpenUI Lang file inside the workspace: /openui-file path/to/widget.oui",
		handler: async (args: string, ctx: any) => {
			const rawPath = args.trim();
			if (!rawPath) return ctx.ui.notify("usage: /openui-file path/to/widget.oui", "warning");
			const cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : currentCwd;
			const resolved = resolveWorkspaceFilePath(rawPath, cwd, LIMITS.source);
			if (!resolved.ok) return ctx.ui.notify(resolved.error, "error");
			try {
				draw(readFileSync(resolved.realPath, "utf8"), basename(resolved.realPath), ctx);
			} catch (e) {
				ctx.ui.notify(`cannot read file: ${stripControl((e as Error).message, false)}`, "error");
			}
		},
	});

	pi.registerCommand("openui-notes", {
		description: "Write notes on the newest widget: click an element (or Tab to it and press Enter), type, Enter to save. Then add them to your message.",
		handler: async (_a: string, ctx: any) => {
			if (!toggleNotesNewest()) ctx.ui.notify("no widget yet: run /openui-gallery", "warning");
		},
	});

	pi.registerCommand("openui-focus", {
		description: "Give the keyboard to the newest widget (Tab/arrows move, Enter activates, Esc leaves)",
		handler: async (_a: string, ctx: any) => {
			if (!armNewest()) ctx.ui.notify("no widget yet: run /openui-gallery", "warning");
		},
	});

	pi.on("message_start", async (event: any) => {
		const m = event?.message;
		if (m?.role !== "user") return;
		const words = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("") : "";
		confirmDelivery(words);
	});

	let unsub: (() => void) | undefined;
	pi.on("session_start", async (_e: any, ctx: any) => {
		if (typeof ctx?.cwd === "string" && ctx.cwd) {
			currentCwd = ctx.cwd;
			imageService.setCwd(currentCwd);
		}
		if (!ctx.hasUI) return;
		unsub?.();
		hooks.queued = () => {
			try {
				return !!ctx.hasPendingMessages();
			} catch {
				return false;
			}
		};
		unsub = ctx.ui.onTerminalInput((data: string) => (handleKey(data) ? { consume: true } : undefined));
		hooks.prompt = (title: string, initial: string) => ctx.ui.editor(stripControl(title, false), initial);
		hooks.toEditor = (text: string) => ctx.ui.pasteToEditor(neutralizePrompt(text, { allowNewlines: true, prefixCommand: "" }));
		ctx.ui.setWidget("openui-hint", (tui: any, theme: any) => {
			hooks.requestRender = () => tui.requestRender();
			return {
				render: (w: number) => {
					if (!active.id) return [];
					const e = entryOf(active.id);
					const keys = e?.state.confirming
						? "confirm action: Enter on [Confirm] or [Cancel]  Esc cancels"
						: e?.state.noteMode
							? "notes: click or Enter writes a note  arrows/Tab move  Shift+Enter picks the parent  Esc leaves"
							: e?.state.focus
								? "arrows move  Tab next  Enter activate  Esc close/leave"
								: "Tab or arrows select  Enter activate  Esc leave";
					return [truncateToWidth(theme.fg("accent", " openui ") + theme.fg("dim", keys), w)];
				},
				invalidate() {},
			};
		});
	});
	pi.on("session_shutdown", async () => {
		unsub?.();
		unsub = undefined;
		compiled.clear();
		compiledChars = 0;
		resetAll();
	});
}
