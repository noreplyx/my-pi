import { textWidth, truncateText, type Cell, type Rect } from "../diagram/canvas.ts";
import type { Block } from "./types.ts";
import { cell, fromRows, padRow, textCells } from "./util.ts";

export interface TableAnchors {
	rows: Rect[];
	cols: Rect[];
	cells: Rect[][];
}

const NUMERIC = /^[-+]?[\d.,]+\s*(%|ms|s|kb|mb|gb|tb|x)?$/i;

export function tableBlock(columns: string[], rows: Array<Array<string | number>>, width: number): { block: Block; anchors: TableAnchors } {
	const n = Math.max(1, columns.length);
	const str = (v: string | number) => String(v ?? "").replace(/\s+/g, " ").trim();
	const data = rows.map((r) => columns.map((_, i) => str(r[i] ?? "")));
	const heads = columns.map(str);
	const numeric = heads.map((_, i) => data.length > 0 && data.every((r) => r[i] === "" || NUMERIC.test(r[i])));
	const nat = heads.map((h, i) => Math.max(textWidth(h), ...data.map((r) => textWidth(r[i])), 1));
	const avail = Math.max(n, width - (3 * n + 1));
	const w = nat.slice();
	let sum = w.reduce((a, b) => a + b, 0);
	while (sum > avail) {
		let k = 0;
		for (let i = 1; i < n; i++) if (w[i] > w[k]) k = i;
		if (w[k] <= 3) break;
		w[k]--;
		sum--;
	}
	const total = w.reduce((a, b) => a + b, 0) + 3 * n + 1;
	const line = (l: string, m: string, r: string): Cell[] => {
		const out: Cell[] = [cell(l, "table.border")];
		w.forEach((cw, i) => {
			for (let k = 0; k < cw + 2; k++) out.push(cell("─", "table.border"));
			out.push(cell(i === n - 1 ? r : m, "table.border"));
		});
		return out;
	};
	const rowCells = (vals: string[], role: string, align: boolean[]): Cell[] => {
		const out: Cell[] = [cell("│", "table.border")];
		vals.forEach((v, i) => {
			const t = truncateText(v, w[i]);
			const tw = textWidth(t);
			const pad = w[i] - tw;
			out.push(cell(" "));
			if (align[i]) for (let k = 0; k < pad; k++) out.push(cell(" "));
			out.push(...textCells(t, role));
			if (!align[i]) for (let k = 0; k < pad; k++) out.push(cell(" "));
			out.push(cell(" "), cell("│", "table.border"));
		});
		return out;
	};
	const out: Cell[][] = [line("┌", "┬", "┐")];
	out.push(rowCells(heads, "table.head", heads.map(() => false)));
	out.push(line("├", "┼", "┤"));
	data.forEach((r) => out.push(rowCells(r, "", numeric)));
	out.push(line("└", "┴", "┘"));
	const colX: number[] = [];
	let x = 1;
	w.forEach((cw) => {
		colX.push(x + 1);
		x += cw + 3;
	});
	const anchors: TableAnchors = {
		cols: w.map((cw, i) => ({ x: colX[i], y: 1, w: cw, h: 1 })),
		rows: data.map((_, ri) => ({ x: 0, y: 3 + ri, w: total, h: 1 })),
		cells: data.map((_, ri) => w.map((cw, i) => ({ x: colX[i], y: 3 + ri, w: cw, h: 1 }))),
	};
	return { block: fromRows(total, out.map((r) => padRow(r, total))), anchors };
}
