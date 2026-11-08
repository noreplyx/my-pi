// Dispatcher: a compiled element tree -> a Block (rows of cells + click/focus targets).
import { textWidth, truncateText, type Cell } from "../diagram/canvas.ts";
import type { El } from "../lang/library.ts";
import { isSafeKey } from "../security.ts";
import { barChart, lineArea, pieChart, radarChart } from "./charts.ts";
import { collectChoices } from "./choice.ts";
import { codeBlock } from "./code.ts";
import { addWholeItem, answerBar, button, callout, card, choice, faq, image, metric, stack, tabs, text, withTips, type Anchor } from "./core.ts";
import { dagBlock, erdBlock, infraBlock, panBlock } from "./diagrams.ts";
import { geoMap } from "./geo.ts";
import { markdownBlock } from "./markdown.ts";
import { decorateNotes, widgetTitle } from "./notes.ts";
import { sequence } from "./sequence.ts";
import { tableBlock } from "./table.ts";
import type { Block, ConfirmRequest, Ctx, Services, Target, WState } from "./types.ts";
import { blank, boxed, cell, fromRows, textBlock, textCells, vstack } from "./util.ts";

/** Most rows one widget may have. The validation limits keep a widget far below this; it is the backstop, not the plan. */
export const MAX_ROWS = 1500;

function capRows(block: Block, warnings: string[]): Block {
	if (block.rows.length <= MAX_ROWS) return block;
	warnings.push(`${block.rows.length - MAX_ROWS} more rows are not drawn: a widget is limited to ${MAX_ROWS} rows. Show less`);
	return { w: block.w, rows: block.rows.slice(0, MAX_ROWS), targets: block.targets.filter((t) => t.rect.y + t.rect.h <= MAX_ROWS) };
}

const CONFIRM_YES = "[ Confirm ]";
const CONFIRM_NO = "[ Cancel ]";

export function confirmBar(req: ConfirmRequest, width: number): Block {
	const iw = Math.max(20, width - 4);
	const previewText = truncateText(req.preview, iw);
	const previewRow = textCells(previewText, "text.warn");
	const yesW = textWidth(CONFIRM_YES);
	const noW = textWidth(CONFIRM_NO);
	const btnRow: Cell[] = [...textCells(CONFIRM_YES, "btn"), cell(" "), cell(" "), ...textCells(CONFIRM_NO, "btn")];
	const targets: Target[] = [
		{ id: "confirm-yes", kind: "confirm-yes", rect: { x: 0, y: 1, w: yesW, h: 1 }, label: "Confirm" },
		{ id: "confirm-no", kind: "confirm-no", rect: { x: yesW + 2, y: 1, w: noW, h: 1 }, label: "Cancel" },
	];
	return boxed(fromRows(iw, [previewRow, btnRow], targets), {
		role: "callout.warn",
		title: "Confirm action",
		titleRole: "callout.warn",
	});
}

export function renderTree(root: El, width: number, state: WState, services: Services = {}): { block: Block; warnings: string[] } {
	const warnings: string[] = [];
	const ctx: Ctx = { state, warnings, services, tabs: [], render: (el, w, path) => renderEl(el, w, path, ctx) };
	const w = Math.max(20, width);
	let base = capRows(renderEl(root, w, "0", ctx), warnings);
	const choices = collectChoices(root);
	if (choices.length) base = vstack([base, answerBar(choices, state, widgetTitle(root), w)], 1, Math.max(base.w, w));
	let block = decorateNotes(base, state, w);
	if (state.confirming) {
		const cbar = confirmBar(state.confirming, w);
		block = vstack([block, cbar], 0, Math.max(block.w, cbar.w));
	}
	return { block, warnings };
}

export function renderEl(el: El, width: number, path: string, ctx: Ctx): Block {
	try {
		const block = renderInner(el, width, path, ctx);
		addWholeItem(el, block, path, ctx);
		return block;
	} catch (e) {
		ctx.warnings.push(`${el.type} could not be drawn: ${(e as Error).message}`);
		return textBlock(`[${el.type} could not be drawn]`, width, "text.warn");
	}
}

function renderInner(el: El, width: number, path: string, ctx: Ctx): Block {
	const p = el.props;
	switch (el.type) {
		case "Stack":
			return stack(el, width, ctx, path);
		case "Text":
			return text(el, width);
		case "Card":
			return card(el, width, ctx, path);
		case "Callout":
			return callout(el, width);
		case "Button":
			return button(el, width, path);
		case "Choice":
			return choice(el, width, ctx, path);
		case "Tabs":
			return tabs(el, width, ctx, path);
		case "Faq":
			return faq(el, width, ctx, path);
		case "Markdown":
			return markdownBlock(String(p.text ?? ""), width, ctx, path);
		case "CodeBlock": {
			const id = `copy:${path}`;
			return codeBlock(String(p.code ?? ""), p.language, p.title, width, id, ctx.state.copied === id);
		}
		case "Metric": {
			const m = metric(el, width, path);
			return withTips(el, m.block, m.anchors as Map<string, Anchor>, path, ctx, width);
		}
		case "Image": {
			const m = image(el, width, path, ctx);
			return withTips(el, m.block, m.anchors, path, ctx, width);
		}
		case "Table": {
			const t = tableBlock(p.columns ?? [], p.rows ?? [], width);
			const anchors = new Map<string, Anchor>();
			const cols: string[] = (p.columns ?? []).map(String);
			const pad = (c: { x: number; w: number }, y: number): [number, number] => [c.x + c.w, y];
			const lastCol = t.anchors.cols[t.anchors.cols.length - 1];
			t.anchors.rows.forEach((r, i) => anchors.set(`row:${i + 1}`, { rect: r, badge: lastCol ? pad(lastCol, r.y) : undefined }));
			t.anchors.cols.forEach((r, i) => anchors.set(`col:${cols[i]}`, { rect: r, badge: pad(r, r.y) }));
			t.anchors.cells.forEach((rs, ri) => rs.forEach((r, ci) => anchors.set(`cell:${ri + 1}.${cols[ci]}`, { rect: r, badge: pad(r, r.y) })));
			const key = `pan:${path}`;
			const pb = panBlock(t.block, width, key, ctx);
			const dx = pb === t.block ? 0 : isSafeKey(key) ? ctx.state.pan[key] ?? 0 : 0;
			if (dx) {
				for (const [, a] of anchors) {
					a.rect = { ...a.rect, x: a.rect.x - dx };
					if (a.badge) a.badge = [a.badge[0] - dx, a.badge[1]];
				}
			}
			return withTips(el, pb, anchors, path, ctx, width);
		}
		case "BarChart": {
			const b = barChart(el, width);
			return withTips(el, b.block, b.anchors, path, ctx, width);
		}
		case "LineChart":
		case "AreaChart": {
			const c = lineArea(el, width, el.type === "AreaChart");
			return withTips(el, c.block, c.anchors, path, ctx, width);
		}
		case "PieChart": {
			const c = pieChart(el, width);
			return withTips(el, c.block, c.anchors, path, ctx, width);
		}
		case "RadarChart": {
			const c = radarChart(el, width);
			return withTips(el, c.block, c.anchors, path, ctx, width);
		}
		case "GeoMap": {
			const g = geoMap(el, width);
			return withTips(el, g.block, g.anchors, path, ctx, width);
		}
		case "Dag": {
			const d = dagBlock(el, width, path, ctx);
			return withTips(el, d.block, d.anchors, path, ctx, width);
		}
		case "Erd": {
			const d = erdBlock(el, width, path, ctx);
			return withTips(el, d.block, d.anchors, path, ctx, width);
		}
		case "InfraMap": {
			const d = infraBlock(el, width, path, ctx);
			return withTips(el, d.block, d.anchors, path, ctx, width);
		}
		case "SequenceDiagram": {
			const s = sequence(el, width, path);
			const b = panBlock(s.block, width, `pan:${path}`, ctx);
			if (b !== s.block) {
				const pan = b.targets[0]?.pan;
				const dx = pan ? pan.x - b.targets[0].rect.x : 0;
				for (const [, a] of s.anchors) {
					a.rect = { ...a.rect, x: a.rect.x - dx };
					if (a.badge) a.badge = [a.badge[0] - dx, a.badge[1]];
				}
			}
			return withTips(el, b, s.anchors, path, ctx, width);
		}
		default:
			ctx.warnings.push(`${el.type} cannot be drawn on its own`);
			return blank(width, 0);
	}
}
