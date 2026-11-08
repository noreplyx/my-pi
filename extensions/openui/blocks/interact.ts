// Interaction logic, independent of any terminal: hit testing, activation, keyboard navigation, pan reveal, and outbound action confirmation.
import { createNullMap, isSafeKey } from "../security.ts";
import { buildMessage, progress, toggleOption } from "./choice.ts";
import type { Block, ConfirmRequest, Target, WState } from "./types.ts";

export interface Env {
	/** send text to the assistant as the user's next turn. `confirm`: the sender will lock something until the host says it took the text */
	send(text: string, opts?: { confirm?: boolean }): void;
	/** put text on the clipboard */
	copy(text: string): void;
	/** show a short notice under the widget */
	note(text: string): void;
	/** stage an outbound action for explicit user confirmation before sending or copying */
	requestConfirm?(req: ConfirmRequest): void;
}

const area = (t: Target) => t.rect.w * t.rect.h;

/**
 * Which targets answer to the mouse and keyboard. Outside notes mode everything except note items. In notes mode: the note
 * items, the notes tray, and tabs (so you can reach content on another tab). Buttons, choices and the like do not fire.
 */
export function isLive(t: Target, notes: boolean): boolean {
	if (!notes) return t.kind !== "item";
	return t.kind === "item" || t.kind === "tab" || t.kind === "note" || t.kind === "noteadd" || t.kind === "noteclear" || t.kind === "notes";
}

/** The most specific target at a point: an exact cell match (a pie wedge) beats a rectangle, a small rectangle beats a big one. */
export function targetAt(block: Block, x: number, y: number, notes = false): Target | null {
	let best: Target | null = null;
	let bestScore = Infinity;
	for (const t of block.targets) {
		if (!isLive(t, notes)) continue;
		const r = t.rect;
		const inRect = x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h && r.x + r.w > 0 && r.x < block.w;
		const inCells = !!t.cells && t.cells.some(([cx, cy]) => cx === x && cy === y);
		if (!inRect && !inCells) continue;
		const score = inCells ? 0 : area(t);
		if (score < bestScore) {
			bestScore = score;
			best = t;
		}
	}
	return best;
}

export function readingOrder(block: Block, notes = false): Target[] {
	return block.targets.filter((t) => isLive(t, notes)).sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.id.localeCompare(b.id));
}

export type NavKey = "next" | "prev" | "left" | "right" | "up" | "down";

/** The neighbour of `cur` in a direction among `order`, or `cur` when there is none. Rectangles must be separated along the axis. */
function spatial(order: Target[], cur: Target, key: "left" | "right" | "up" | "down"): Target {
	const cx = (t: Target) => t.rect.x + t.rect.w / 2;
	const cy = (t: Target) => t.rect.y + t.rect.h / 2;
	const horizontal = key === "left" || key === "right";
	const inDirection = order.filter((t) => {
		if (t === cur) return false;
		const r = t.rect;
		const c = cur.rect;
		return key === "left" ? r.x + r.w <= c.x : key === "right" ? r.x >= c.x + c.w : key === "up" ? r.y + r.h <= c.y : r.y >= c.y + c.h;
	});
	const overlaps = (t: Target) => (horizontal ? t.rect.y < cur.rect.y + cur.rect.h && cur.rect.y < t.rect.y + t.rect.h : t.rect.x < cur.rect.x + cur.rect.w && cur.rect.x < t.rect.x + t.rect.w);
	const aligned = inDirection.filter(overlaps);
	const shared = (t: Target) => {
		const a0 = horizontal ? t.rect.y : t.rect.x;
		const a1 = a0 + (horizontal ? t.rect.h : t.rect.w);
		const b0 = horizontal ? cur.rect.y : cur.rect.x;
		const b1 = b0 + (horizontal ? cur.rect.h : cur.rect.w);
		return Math.min(a1, b1) - Math.max(a0, b0) >= 0.5 * Math.min(a1 - a0, b1 - b0);
	};
	const hasRowMates = order.some((t) => t !== cur && shared(t));
	if (!aligned.length && hasRowMates) return cur;
	const pool = aligned.length ? aligned : inDirection;
	let best: Target | null = null;
	let bestScore = Infinity;
	for (const t of pool) {
		const along = Math.abs(horizontal ? cx(t) - cx(cur) : cy(t) - cy(cur));
		const across = Math.abs(horizontal ? cy(t) - cy(cur) : cx(t) - cx(cur));
		const score = along + across * (horizontal ? 3 : 2);
		if (score < bestScore) {
			bestScore = score;
			best = t;
		}
	}
	return best ?? cur;
}

/**
 * Notes mode. Tab hops between components (and the tray, and tabs). Arrows move among the parts of the component you are in:
 * from the whole component they step into its first or last part; past the last part they move on to the next component.
 */
function notesNav(pool: Target[], currentId: string | null, key: NavKey): Target | null {
	const order = [...pool].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.id.localeCompare(b.id));
	const ring = order.filter((t) => t.kind !== "item" || t.item?.key === "");
	if (!ring.length) return null;
	const cur = order.find((t) => t.id === currentId) ?? null;
	const ringStop = (t: Target): Target => (t.kind === "item" && t.item!.key !== "" ? ring.find((r) => r.kind === "item" && r.item!.host === t.item!.host && r.item!.key === "") ?? ring[0] : t);
	const step = (from: Target, d: 1 | -1): Target => {
		const stop = ringStop(from);
		const i = ring.indexOf(stop);
		return ring[(i + d + ring.length) % ring.length];
	};
	if (!cur) return key === "prev" || key === "up" || key === "left" ? ring[ring.length - 1] : ring[0];
	if (key === "next") return step(cur, 1);
	if (key === "prev") return step(cur, -1);
	const fwd = key === "down" || key === "right";
	if (cur.kind === "item") {
		const leaves = order.filter((t) => t.kind === "item" && t.item!.host === cur.item!.host && t.item!.key !== "");
		if (cur.item!.key === "") {
			if (!leaves.length) return step(cur, fwd ? 1 : -1);
			return fwd ? leaves[0] : leaves[leaves.length - 1];
		}
		const to = spatial(leaves, cur, key);
		if (to !== cur) return to;
		return step(cur, fwd ? 1 : -1);
	}
	if (key === "up" || key === "down") {
		const below = key === "down";
		const lines = ring.filter((t) => (below ? t.rect.y >= cur.rect.y + cur.rect.h : t.rect.y + t.rect.h <= cur.rect.y));
		if (!lines.length) return step(cur, below ? 1 : -1);
		const y = below ? Math.min(...lines.map((t) => t.rect.y)) : Math.max(...lines.map((t) => t.rect.y));
		return lines.filter((t) => t.rect.y === y).sort((a, b) => a.rect.x - b.rect.x)[0];
	}
	const same = order.filter((t) => t.kind !== "item");
	return spatial(same, cur, key);
}

export function nextTarget(block: Block, currentId: string | null, key: NavKey, notes = false): Target | null {
	const pool = block.targets.filter((t) => isLive(t, notes));
	if (notes) return notesNav(pool, currentId, key);
	const order = [...pool].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.id.localeCompare(b.id));
	if (!order.length) return null;
	const cur = order.find((t) => t.id === currentId) ?? null;
	if (key === "next" || key === "prev") {
		if (!cur) return key === "next" ? order[0] : order[order.length - 1];
		const i = order.indexOf(cur);
		return order[(i + (key === "next" ? 1 : -1) + order.length) % order.length];
	}
	if (!cur) return order[0];
	const to = spatial(order, cur, key);
	if ((key === "down" || key === "up") && to.kind === "clear" && cur.kind !== "send" && cur.kind !== "clear") return order.find((t) => t.kind === "send") ?? to;
	return to;
}

const lastColon = (id: string) => id.lastIndexOf(":");

function stageConfirm(state: WState, env: Env, req: ConfirmRequest): boolean {
	state.confirming = req;
	env.requestConfirm?.(req);
	return true;
}

/** Apply a target's action. Returns true when the layout changed and the block must be rebuilt. */
export function activate(t: Target, state: WState, env: Env): boolean {
	switch (t.kind) {
		case "tab": {
			const k = lastColon(t.id);
			const path = t.id.slice(4, k);
			const i = Number(t.id.slice(k + 1));
			if (!isSafeKey(path)) return false;
			const cur = state.tab[path] ?? -1;
			const next = i === -1 || cur === i ? -1 : i;
			if (next === cur) return false;
			state.tab[path] = next;
			state.tip = null;
			state.confirming = null;
			return true;
		}
		case "faq":
			if (!isSafeKey(t.id)) return false;
			state.faq[t.id] = !state.faq[t.id];
			state.confirming = null;
			return true;
		case "choice": {
			const x = t.choice;
			if (!x || state.sent || x.index === "other") return false;
			state.answers = toggleOption(state.answers, x.of, x.index);
			state.confirming = null;
			return true;
		}
		case "send": {
			const x = t.bar;
			if (!x || state.sent || !progress(x.choices, state.answers).answered) return false;
			const msg = buildMessage(x.choices, state.answers, x.title);
			return stageConfirm(state, env, {
				targetId: t.id,
				kind: "send-choices",
				preview: `Send answers: "${msg.replace(/\s+/g, " ").slice(0, 72)}"`,
				payload: msg,
			});
		}
		case "clear":
			if (state.sent) return false;
			state.answers = createNullMap();
			state.confirming = null;
			return true;
		case "button":
			if (t.send) {
				return stageConfirm(state, env, {
					targetId: t.id,
					kind: "send-button",
					preview: `Send to assistant: "${t.send.replace(/\s+/g, " ").slice(0, 72)}"`,
					payload: t.send,
				});
			}
			if (t.openUrl) {
				return stageConfirm(state, env, {
					targetId: t.id,
					kind: "open-url",
					preview: `Copy URL: ${t.openUrl.slice(0, 72)}`,
					payload: t.openUrl,
				});
			}
			return false;
		case "confirm-yes": {
			const c = state.confirming;
			if (!c) return false;
			state.confirming = null;
			if (c.kind === "send-button") {
				env.send(c.payload);
			} else if (c.kind === "send-choices") {
				env.send(c.payload, { confirm: true });
				state.sent = true;
			} else if (c.kind === "open-url") {
				env.copy(c.payload);
				env.note(`link copied: ${c.payload}`);
			}
			return true;
		}
		case "confirm-no": {
			if (!state.confirming) return false;
			state.confirming = null;
			return true;
		}
		case "copy":
			if (t.copy !== undefined) env.copy(t.copy);
			state.copied = t.id;
			return true;
		case "node":
		case "image":
		case "tip": {
			const tip = t.tip;
			if (!tip || !(tip.detail || tip.code || tip.link)) return false;
			state.tip = state.tip === t.id ? null : t.id;
			return true;
		}
	}
	return false;
}

/** Scroll a wide diagram so the target is visible. Returns true when the pan changed. */
export function reveal(t: Target, state: WState): boolean {
	const p = t.pan;
	if (!p || !isSafeKey(p.key)) return false;
	const cur = state.pan[p.key] ?? 0;
	let next = cur;
	if (p.x < cur) next = Math.max(0, p.x - 2);
	else if (p.x + p.w > cur + p.view) next = Math.min(p.total - p.view, p.x + p.w - p.view + 2);
	if (next === cur) return false;
	state.pan[p.key] = next;
	return true;
}

/** The one-line explanation shown for a hovered or focused target. */
export function describe(t: Target): string {
	const bits: string[] = [];
	switch (t.kind) {
		case "button":
			bits.push(`[${t.label}]`, t.send ? `sends "${t.send.length > 70 ? t.send.slice(0, 69) + "…" : t.send}"` : t.openUrl ? `link ${t.openUrl}` : "");
			break;
		case "choice":
			bits.push(t.label, t.choice?.index === "other" ? "Enter to type your own answer" : t.choice?.of.multiple ? "Enter to toggle" : "Enter to select");
			break;
		case "send":
			bits.push("send all the answers to the agent as one message");
			break;
		case "clear":
			bits.push("clear every answer");
			break;
		case "confirm-yes":
			bits.push("confirm and execute this widget action");
			break;
		case "confirm-no":
			bits.push("cancel this widget action (or press Esc)");
			break;
		case "tab":
			bits.push(`tab ${t.label}`);
			break;
		case "faq":
			bits.push(t.label, "Enter to open or close");
			break;
		case "copy":
			bits.push("copy the code to the clipboard");
			break;
		case "image":
			bits.push(t.label);
			break;
		case "item":
			bits.push(t.label, "Enter to write a note");
			break;
		case "note":
			bits.push(`${t.label}`, "Enter to edit, Delete to remove");
			break;
		case "notes":
			bits.push("notes: click an element, or Tab to it and press Enter, to write a note about it");
			break;
		case "noteadd":
			bits.push("put the notes in your message box (nothing is sent)");
			break;
		case "noteclear":
			bits.push("discard all notes on this widget");
			break;
		default:
			bits.push(t.label);
	}
	if (t.tip?.hint) bits.push(t.tip.hint);
	if (t.tip && (t.tip.detail || t.tip.code || t.tip.link)) bits.push("Enter for details");
	return bits.filter(Boolean).join("  ·  ");
}
