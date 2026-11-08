// pi-tui component for a compiled OpenUI tree: themed colours, hover, click, keyboard, clipboard, pictures, notes,
// bounded 64-entry LRU widget cache, and inline confirmation before outbound actions.
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { drawBubble } from "../blocks/bubble.ts";
import { otherLength, setOther } from "../blocks/choice.ts";
import { BADGE } from "../blocks/core.ts";
import { activate, describe, nextTarget, readingOrder, reveal, targetAt, type Env, type NavKey } from "../blocks/interact.ts";
import { buildMessage, cleanNote, NOTE_LIMITS, widgetTitle } from "../blocks/notes.ts";
import { renderTree } from "../blocks/render.ts";
import { newState, type Block, type Note, type Target, type WState } from "../blocks/types.ts";
import { cell, padRow, textCells } from "../blocks/util.ts";
import { rowsToLines, textWidth, truncateText, type Cell } from "../diagram/canvas.ts";
import { createPalette } from "../diagram/palette.ts";
import { LIMITS, type El } from "../lang/library.ts";
import { neutralizePrompt, stripControl } from "../security.ts";
import { imageService } from "./images.ts";

const GUTTER = 2;
const RIGHT = 1;
const CHIP = "notes:chip";
const SERIES = ["accent", "success", "warning", "error", "syntaxKeyword", "syntaxString", "syntaxType", "syntaxNumber"];
const sgr = (open: string, close: string) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;

export const MAX_WIDGET_ENTRIES = 64;

export function themePalette(theme: any) {
	const f = (token: string) => (s: string) => theme.fg(token, s);
	const colors = theme.colors ?? {};
	return createPalette({
		good: f("success"),
		bad: f("error"),
		warn: f("warning"),
		accent: f("accent"),
		info: f("accent"),
		muted: f("muted"),
		dim: f("dim"),
		bold: sgr("1", "22"),
		italic: sgr("3", "23"),
		underline: sgr("4", "24"),
		strike: sgr("9", "29"),
		code: f("mdCode"),
		keyword: f("syntaxKeyword"),
		string: f("syntaxString"),
		number: f("syntaxNumber"),
		comment: f("syntaxComment"),
		fn: f("syntaxFunction"),
		type: f("syntaxType"),
		link: f("mdLink"),
		series: SERIES.map(f),
		bubble: (s) => theme.bg("selectedBg", theme.fg("text", s)),
		pie: (a, b) => (s) => {
			if (a !== null && b !== null && typeof theme.style === "function" && colors[SERIES[b % 8]]) return theme.style(s, { fg: SERIES[a % 8], bg: colors[SERIES[b % 8]] });
			return theme.fg(SERIES[((a ?? b) as number) % 8], s);
		},
	});
}

export type Mode = "live" | "echo";

interface Entry {
	root: El;
	state: WState;
	mode: Mode;
	block: Block | null;
	key: string;
	version: number;
	warnings: string[];
	notice: string | null;
	noticeTimer: ReturnType<typeof setTimeout> | null;
	/** answers handed to pi, waiting for its word that it took them (see watchDelivery) */
	pending: { text: string; timer: ReturnType<typeof setTimeout> | null } | null;
	/** the finished lines and what they were drawn from: pi asks for them on every frame, so an unchanged widget answers from here */
	lines: string[] | null;
	lineKey: string;
}

const entries = new Map<string, Entry>();
export const active: { id: string | null } = { id: null };
export const newestId: { id: string | null } = { id: null };
/** A dialog (the note editor) is open: our key and mouse handlers stand down so its keys are its own. */
export const dialog = { open: false };

/** Services the extension provides. Tests replace them. */
export const hooks = {
	requestRender: () => {},
	sendLive: (_text: string) => {},
	sendEcho: (_text: string) => {},
	/** Is pi holding messages for later (the agent is busy and a follow-up is queued)? Then a message it has not shown yet is not lost. */
	queued: (): boolean => false,
	/** How long to wait for pi to say it took the answers before giving the widget back. */
	deliveryMs: 3000,
	/** Ask the user for the text of a note. Resolves undefined when they cancel. */
	prompt: async (_title: string, _initial: string): Promise<string | undefined> => undefined,
	/** Put text in pi's message box without sending it. */
	toEditor: (_text: string) => {},
	copy: (text: string) => {
		try {
			const safeText = stripControl(text, true);
			process.stdout.write(`\x1b]52;c;${Buffer.from(safeText, "utf8").toString("base64")}\x07`);
		} catch {
			/* no terminal */
		}
	},
};

export const entryOf = (id: string): Entry | undefined => entries.get(id);
export const widgetEntryCount = (): number => entries.size;

// pi converts JPEG, GIF and WebP lazily after startup: when a picture becomes drawable, lay every widget out again
imageService.onLate = () => {
	for (const e of entries.values()) e.version++;
	hooks.requestRender();
};

function disposeEntryTimers(e: Entry): void {
	if (e.noticeTimer) {
		clearTimeout(e.noticeTimer);
		e.noticeTimer = null;
	}
	if (e.pending?.timer) {
		clearTimeout(e.pending.timer);
		e.pending.timer = null;
	}
}

function getEntry(id: string, root: El, mode: Mode): Entry {
	const existing = entries.get(id);
	if (existing) {
		// Refresh LRU position
		entries.delete(id);
		entries.set(id, existing);
		return existing;
	}
	while (entries.size >= MAX_WIDGET_ENTRIES) {
		const oldestKey = entries.keys().next().value;
		if (oldestKey === undefined) break;
		const oldest = entries.get(oldestKey);
		if (oldest) disposeEntryTimers(oldest);
		entries.delete(oldestKey);
		if (active.id === oldestKey) active.id = null;
		if (newestId.id === oldestKey) newestId.id = null;
	}
	const e: Entry = {
		root,
		state: newState(),
		mode,
		block: null,
		key: "",
		version: 0,
		warnings: [],
		notice: null,
		noticeTimer: null,
		pending: null,
		lines: null,
		lineKey: "",
	};
	entries.set(id, e);
	newestId.id = id;
	return e;
}

function envFor(id: string, e: Entry): Env {
	return {
		send: (t, o) => {
			if (e.mode !== "live") return hooks.sendEcho(t);
			const clean = neutralizePrompt(t, { allowNewlines: true });
			if (o?.confirm) watchDelivery(id, e, clean);
			hooks.sendLive(clean);
		},
		copy: (t) => hooks.copy(t),
		note: (t) => setNotice(id, t),
		requestConfirm: (req) => {
			e.state.confirming = req;
			e.state.focus = "confirm-yes";
			e.version++;
			setNotice(id, `Confirm action: ${req.preview}`);
			hooks.requestRender();
		},
	};
}

function setNotice(id: string, text: string | null) {
	const e = entries.get(id);
	if (!e) return;
	const safeText = text ? stripControl(text, false) : null;
	e.notice = safeText;
	if (e.noticeTimer) clearTimeout(e.noticeTimer);
	e.noticeTimer = safeText
		? setTimeout(() => {
				e.notice = null;
				hooks.requestRender();
			}, 4000)
		: null;
	if (e.noticeTimer && typeof (e.noticeTimer as any).unref === "function") (e.noticeTimer as any).unref();
}

function afterActivate(id: string, e: Entry, t: Target, layoutChanged: boolean) {
	if (layoutChanged) e.version++;
	if (t.kind === "copy") {
		const timer = setTimeout(() => {
			if (e.state.copied === t.id) {
				e.state.copied = null;
				e.version++;
				hooks.requestRender();
			}
		}, 1800);
		if (typeof (timer as any).unref === "function") (timer as any).unref();
	}
	void id;
}

// ---------- delivery ----------

function watchDelivery(id: string, e: Entry, text: string): void {
	if (e.pending?.timer) clearTimeout(e.pending.timer);
	e.state.sending = true;
	const pending: NonNullable<Entry["pending"]> = { text, timer: null };
	e.pending = pending;
	const check = () => {
		if (e.pending !== pending) return;
		let held = false;
		try {
			held = hooks.queued();
		} catch {
			/* pi's context went stale: treat it as not held */
		}
		if (held) return void (pending.timer = later(check));
		e.pending = null;
		e.state.sent = false;
		e.state.sending = false;
		e.version++;
		setNotice(id, "pi did not take the answers. Fix what it says above, then Send again.");
		hooks.requestRender();
	};
	pending.timer = later(check);
}
const later = (f: () => void) => {
	const t = setTimeout(f, Math.max(1, hooks.deliveryMs));
	if (typeof (t as any).unref === "function") (t as any).unref();
	return t;
};

/**
 * pi reported a user message with this text: the oldest widget waiting for it has been delivered. One message confirms one widget,
 * so two widgets that sent the same words are each confirmed by their own message.
 */
export function confirmDelivery(text: string): boolean {
	const want = text.trim();
	for (const e of entries.values()) {
		if (!e.pending || e.pending.text.trim() !== want) continue;
		if (e.pending.timer) clearTimeout(e.pending.timer);
		e.pending = null;
		e.state.sending = false;
		e.version++;
		hooks.requestRender();
		return true;
	}
	return false;
}

// ---------- notes ----------

const chipLabel = (s: WState) => (s.noteMode ? "[ notes: on ]" : s.notes.length ? `[ notes ${s.notes.length} ]` : "[ notes ]");

function setMode(id: string, e: Entry, on: boolean) {
	e.state.noteMode = on;
	e.state.focus = null;
	e.state.hover = null;
	e.state.tip = null;
	e.state.confirming = null;
	e.version++;
	if (on) active.id = id;
	setNotice(id, null);
	hooks.requestRender();
}

async function writeNote(id: string, e: Entry, t: Target): Promise<void> {
	if (dialog.open || !t.item) return;
	const existing = e.state.notes.find((n) => n.itemId === t.id);
	if (!existing && e.state.notes.length >= NOTE_LIMITS.notes) {
		setNotice(id, `${NOTE_LIMITS.notes} notes is the most per widget.`);
		hooks.requestRender();
		return;
	}
	await ask(id, e, existing ?? null, { itemId: t.id, info: t.item });
}

async function editNote(id: string, e: Entry, noteId: number | undefined): Promise<void> {
	const n = e.state.notes.find((x) => x.id === noteId);
	if (n && !dialog.open) await ask(id, e, n, { itemId: n.itemId, info: n.info });
}

async function ask(id: string, e: Entry, existing: Note | null, about: { itemId: string; info: Note["info"] }): Promise<void> {
	dialog.open = true;
	let text: string | undefined;
	try {
		text = await hooks.prompt(`Note on ${about.info.short}${about.info.tab ? ` [tab ${about.info.tab}]` : ""}${existing ? " (editing)" : ""}`, existing?.text ?? "");
	} finally {
		dialog.open = false;
	}
	if (text === undefined) return;
	let clean = cleanNote(text);
	if (clean.length > NOTE_LIMITS.note) {
		clean = clean.slice(0, NOTE_LIMITS.note).trimEnd();
		setNotice(id, `Note shortened to ${NOTE_LIMITS.note} characters.`);
	}
	if (!clean) {
		if (existing) e.state.notes = e.state.notes.filter((n) => n !== existing);
	} else if (existing) existing.text = clean;
	else e.state.notes.push({ id: ++e.state.noteSeq, itemId: about.itemId, info: about.info, text: clean });
	e.version++;
	hooks.requestRender();
}

function addToMessage(id: string, e: Entry) {
	const n = e.state.notes.length;
	if (!n) return;
	hooks.toEditor(buildMessage(e.state.notes, widgetTitle(e.root)));
	e.state.notes = [];
	e.state.noteMode = false;
	e.state.focus = null;
	if (active.id === id) active.id = null;
	e.version++;
	setNotice(id, `Added ${n} note${n === 1 ? "" : "s"} to your message. Read it, edit it, then press Enter to send.`);
	hooks.requestRender();
}

function clearNotes(id: string, e: Entry) {
	e.state.notes = [];
	e.state.focus = null;
	e.version++;
	setNotice(id, "Notes cleared.");
	hooks.requestRender();
}

// ---------- choices ----------

async function editOther(id: string, e: Entry, t: Target): Promise<void> {
	const x = t.choice;
	if (!x || dialog.open || e.state.sent) return;
	dialog.open = true;
	let text: string | undefined;
	try {
		text = await hooks.prompt(`Your own answer: ${truncateText(x.of.question, 60)}`, e.state.answers[x.of.key]?.text ?? "");
	} finally {
		dialog.open = false;
	}
	if (text === undefined || e.state.sent) return;
	if (otherLength(text) > LIMITS.other) setNotice(id, `Answer shortened to ${LIMITS.other} characters.`);
	e.state.answers = setOther(e.state.answers, x.of, text);
	e.state.confirming = null;
	e.version++;
	hooks.requestRender();
}

/** One place for what a click or Enter does, so the mouse and the keyboard cannot drift apart. */
function perform(id: string, e: Entry, t: Target, shift = false): void {
	switch (t.kind) {
		case "notes":
			setMode(id, e, !e.state.noteMode);
			return;
		case "item": {
			const up = shift && t.item?.parent ? e.block?.targets.find((x) => x.id === t.item!.parent) : undefined;
			void writeNote(id, e, up ?? t);
			return;
		}
		case "note":
			void editNote(id, e, t.noteId);
			return;
		case "noteadd":
			addToMessage(id, e);
			return;
		case "noteclear":
			clearNotes(id, e);
			return;
		case "choice":
			if (t.choice?.index === "other") {
				void editOther(id, e, t).catch(() => {
					setNotice(id, "The editor could not be opened.");
					hooks.requestRender();
				});
				return;
			}
			break;
	}
	const prevConfirm = e.state.confirming;
	const changed = activate(t, e.state, envFor(id, e));
	afterActivate(id, e, t, changed);

	if (t.kind === "confirm-yes") {
		if (e.state.sent) {
			e.state.focus = null;
			if (active.id === id) active.id = null;
		} else {
			e.state.focus = prevConfirm?.targetId ?? null;
		}
	} else if (t.kind === "confirm-no") {
		e.state.focus = prevConfirm?.targetId ?? null;
		setNotice(id, "Action cancelled.");
	} else if (t.kind === "clear" && e.block) {
		e.state.focus = readingOrder(e.block).find((x) => x.kind === "choice")?.id ?? null;
	}
}

// ---------- the component ----------

const confirmKeyOf = (state: WState): string =>
	state.confirming ? `${state.confirming.kind}:${state.confirming.targetId}:${state.confirming.payload}` : "";

const mark = (row: Cell[], x: number, suffix: string) => {
	const c = row[x];
	if (c.role.startsWith("note.")) return;
	if (c.role) row[x] = cell(c.ch, `${c.role}.${suffix}`);
	else if (c.ch.trim()) row[x] = cell(c.ch, suffix);
};

export class OpenUIWidget {
	id: string;
	theme: any;
	private pal: ReturnType<typeof themePalette> | null = null;
	private root: El;
	private mode: Mode;
	constructor(id: string, root: El, theme: any, mode: Mode) {
		this.id = id;
		this.theme = theme;
		this.root = root;
		this.mode = mode;
		getEntry(id, root, mode);
	}

	private layout(width: number): Entry {
		const e = getEntry(this.id, this.root, this.mode);
		const confirmKey = confirmKeyOf(e.state);
		const key = `${width}:${e.version}:${confirmKey}`;
		if (!e.block || e.key !== key) {
			const r = renderTree(e.root, width, e.state, { images: imageService });
			let block = r.block;
			if (block.targets.some((t) => t.kind === "item")) {
				const w = Math.max(block.w, width);
				const label = chipLabel(e.state);
				const cw = textWidth(label);
				const chip: Cell[] = textCells(label, e.state.noteMode ? "notes.on" : "btn");
				const row = padRow([], w - cw).concat(chip);
				block = {
					w,
					rows: [...block.rows.map((x) => padRow(x, w)), row],
					targets: [...block.targets, { id: CHIP, kind: "notes", rect: { x: w - cw, y: block.rows.length, w: cw, h: 1 }, label: "notes" }],
				};
			}
			e.block = block;
			e.warnings = r.warnings;
			e.key = key;
		}
		return e;
	}

	/** the block as last laid out, for tests and the keyboard layer */
	lastBlock(): Block | null {
		return entries.get(this.id)?.block ?? null;
	}

	render(width: number): string[] {
		try {
			const avail = Math.max(24, width - GUTTER - RIGHT);
			const e = this.layout(avail);
			const s = e.state;
			const key = `${e.key}|${s.hover}|${s.focus}|${s.tip}|${s.copied}|${s.noteMode}|${s.notes.length}|${e.notice}|${active.id === this.id}`;
			if (e.lines && e.lineKey === key) return e.lines;
			const lines = this.draw(e, width, avail);
			e.lines = lines;
			e.lineKey = key;
			return lines;
		} catch (err) {
			const msg = stripControl((err as Error)?.message ?? err, false).replace(/\s+/g, " ").slice(0, 120);
			return [truncateToWidth(this.theme.fg("error", `! the widget could not be drawn: ${msg}`), Math.max(1, width))];
		}
	}

	private draw(e: Entry, width: number, avail: number): string[] {
		const block = e.block!;
		const notes = e.state.noteMode;
		const rows: Cell[][] = block.rows.map((r) => r.slice());
		const gutter = new Set<number>();
		const paint = (id: string | null, suffix: string) => {
			if (!id) return;
			const t = block.targets.find((x) => x.id === id);
			if (!t) return;
			if (t.kind === "item" && t.item?.key === "") {
				for (let y = t.rect.y; y < t.rect.y + t.rect.h; y++) gutter.add(y);
				return;
			}
			if (t.kind === "image" && t.image) {
				const r = t.rect;
				for (let y = r.y - 1; y <= r.y + r.h; y++)
					for (let x = r.x - 1; x <= r.x + r.w; x++) {
						const onRing = y === r.y - 1 || y === r.y + r.h || x === r.x - 1 || x === r.x + r.w;
						if (onRing && rows[y]?.[x]) mark(rows[y], x, suffix);
					}
				return;
			}
			for (let y = t.rect.y; y < t.rect.y + t.rect.h; y++) for (let x = Math.max(0, t.rect.x); x < Math.min(block.w, t.rect.x + t.rect.w); x++) if (rows[y]?.[x]) mark(rows[y], x, suffix);
		};
		paint(e.state.hover, "hover");
		paint(e.state.focus, "focus");
		const current = block.targets.find((x) => x.id === (e.state.hover ?? e.state.focus));
		if (current?.tip?.hint && !notes) drawBubble(rows, block.w, current);

		const footerCells = (): Cell[] => {
			const tips = block.targets.filter((x) => x.tip).length;
			if (e.notice) return [...textCells("▸ ", "foot.mark"), ...textCells(e.notice, "foot.text")];
			if (current) return [...textCells("▸ ", "foot.mark"), ...textCells(describe(current), "foot.text")];
			if (notes) return [...textCells("Notes: click an element, or Tab to it and press Enter. Esc leaves.", "foot.text")];
			if (tips) return [...textCells(BADGE, "foot.mark"), ...textCells(` ${tips} element${tips === 1 ? " has a" : "s have"} tooltip${tips === 1 ? "" : "s"}: hover ${tips === 1 ? "it" : "one"}, or press Tab then Enter`, "foot.text")];
			return [];
		};
		const chipT = block.targets.find((t) => t.kind === "notes");
		const text = footerCells();
		if (chipT && rows[chipT.rect.y]) {
			const room = chipT.rect.x - 2;
			const cells = textCells(truncateText(text.map((c) => c.ch).join(""), Math.max(0, room)), "foot.text");
			text.forEach((c, i) => {
				if (cells[i]) cells[i] = cell(cells[i].ch, c.role);
			});
			cells.forEach((c, i) => {
				if (i < rows[chipT.rect.y].length) rows[chipT.rect.y][i] = c;
			});
		} else if (text.length) rows.push(padRow(text, Math.min(avail, Math.max(text.length, 1))));

		const th = this.theme;
		const palette = (this.pal ??= themePalette(th));
		const lines = rowsToLines(rows, palette);
		const imageRows = new Set<number>();
		for (const t of block.targets) {
			if (t.kind !== "image" || !t.image) continue;
			const seq = imageService.sequence(t.image.key);
			const row = rows[t.rect.y];
			if (!seq || !row) continue;
			const left = rowsToLines([row.slice(0, t.rect.x)], palette, false)[0] ?? "";
			const right = rowsToLines([row.slice(t.rect.x + t.image.cols)], palette)[0] ?? "";
			lines[t.rect.y] = left + seq + `\x1b[${t.image.cols}C` + right;
			imageRows.add(t.rect.y);
		}
		for (const w of e.warnings) lines.push(th.fg("warning", `! ${stripControl(w, false)}`));
		const armed = active.id === this.id;
		const edgeFor = (y: number) => (gutter.has(y) ? th.fg("accent", "┃") + " " : armed ? th.fg("accent", "▎") + " " : "  ");
		return lines.map((l, i) => (imageRows.has(i) ? edgeFor(i) + l : truncateToWidth(edgeFor(i) + l, width)));
	}

	handleMouse(ev: any) {
		try {
			return this.mouse(ev);
		} catch {
			return undefined;
		}
	}

	private mouse(ev: any) {
		const e = entries.get(this.id);
		if (!e || !e.block || dialog.open) return undefined;
		const t = targetAt(e.block, ev.x - GUTTER, ev.y, e.state.noteMode);
		if (ev.type === "move") {
			const id = t?.id ?? null;
			if (id === e.state.hover) return undefined;
			e.state.hover = id;
			return { handled: !!t, render: true };
		}
		if (ev.type === "click" && ev.button === "left" && t) {
			active.id = this.id;
			e.state.focus = t.id;
			setNotice(this.id, null);
			perform(this.id, e, t, !!ev.shift);
			if (reveal(t, e.state)) e.version++;
			hooks.requestRender();
			return { handled: true, render: true };
		}
		return undefined;
	}

	invalidate() {
		this.pal = null;
		const e = entries.get(this.id);
		if (!e) return;
		e.lines = null;
		if (e.block?.targets.some((t) => t.kind === "image")) {
			imageService.reset();
			e.version++;
		}
	}
}

/** Keyboard layer while a widget is armed. Returns true when the key was used. Never throws. */
export function handleKey(data: string): boolean {
	try {
		return keyInner(data);
	} catch {
		return false;
	}
}

function keyInner(data: string): boolean {
	if (!active.id || dialog.open) return false;
	const id = active.id;
	const e = entries.get(id);
	if (!e || !e.block) return false;
	const block = e.block;
	const notes = e.state.noteMode;
	if (matchesKey(data, Key.escape)) {
		if (e.state.confirming) {
			const prev = e.state.confirming.targetId;
			e.state.confirming = null;
			e.state.focus = prev;
			e.version++;
			setNotice(id, "Action cancelled.");
		} else if (e.state.tip) {
			e.state.tip = null;
			e.version++;
		} else if (notes) {
			setMode(id, e, false);
			return true;
		} else {
			active.id = null;
			e.state.focus = null;
		}
		hooks.requestRender();
		return true;
	}
	let nav: NavKey | null = null;
	if (matchesKey(data, Key.tab)) nav = "next";
	else if (matchesKey(data, Key.shift("tab"))) nav = "prev";
	else if (matchesKey(data, Key.left)) nav = "left";
	else if (matchesKey(data, Key.right)) nav = "right";
	else if (matchesKey(data, Key.up)) nav = "up";
	else if (matchesKey(data, Key.down)) nav = "down";
	if (nav) {
		const t = nextTarget(block, e.state.focus, nav, notes);
		if (!t) return false;
		e.state.focus = t.id;
		e.state.hover = null;
		setNotice(id, null);
		if (reveal(t, e.state)) e.version++;
		hooks.requestRender();
		return true;
	}
	if (matchesKey(data, Key.enter) || matchesKey(data, Key.shift("enter"))) {
		const focused = e.state.focus ? block.targets.find((x) => x.id === e.state.focus) : undefined;
		if (e.state.focus && !focused) {
			e.state.focus = null;
			e.state.hover = null;
			hooks.requestRender();
			return true;
		}
		const t = focused ?? nextTarget(block, null, "next", notes);
		if (!t) return false;
		e.state.focus = t.id;
		e.state.hover = null;
		perform(id, e, t, matchesKey(data, Key.shift("enter")));
		hooks.requestRender();
		return true;
	}
	if (matchesKey(data, Key.delete) || matchesKey(data, Key.backspace)) {
		const t = block.targets.find((x) => x.id === e.state.focus);
		if (t?.kind === "note") {
			e.state.notes = e.state.notes.filter((n) => n.id !== t.noteId);
			e.state.focus = null;
			e.version++;
			hooks.requestRender();
			return true;
		}
	}
	if ([...data].some((ch) => ch >= " " && ch !== "\x7f")) {
		active.id = null;
		e.state.focus = null;
		e.state.hover = null;
		if (e.state.confirming) {
			e.state.confirming = null;
			e.version++;
		}
		if (e.state.noteMode) {
			e.state.noteMode = false;
			e.version++;
		}
		hooks.requestRender();
	}
	return false;
}

export function armNewest(): string | null {
	if (!newestId.id || !entries.has(newestId.id)) return null;
	active.id = newestId.id;
	const e = entries.get(newestId.id)!;
	if (!e.state.focus && e.block) e.state.focus = nextTarget(e.block, null, "next", e.state.noteMode)?.id ?? null;
	hooks.requestRender();
	return newestId.id;
}

/** Arm the newest widget and switch notes mode on or off. Returns false when there is no widget. */
export function toggleNotesNewest(): boolean {
	if (!newestId.id || !entries.has(newestId.id)) return false;
	const e = entries.get(newestId.id)!;
	setMode(newestId.id, e, !e.state.noteMode);
	return true;
}

/** Forget every widget's state (notes, focus, layouts). Called when a session ends: pi processes live for days. */
export function resetAll() {
	for (const e of entries.values()) {
		disposeEntryTimers(e);
	}
	entries.clear();
	imageService.reset();
	active.id = null;
	newestId.id = null;
	dialog.open = false;
}
