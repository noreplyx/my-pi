import { oneLine, textWidth, type Cell, type Rect } from "../diagram/canvas.ts";
import { stripControl } from "../security.ts";
import type { Block } from "./types.ts";
import { cell, fromRows, padRow, wrapText } from "./util.ts";

export interface TableAnchors {
	rows: Rect[];
	cols: Rect[];
	cells: Rect[][];
}

const NUMERIC = /^[-+]?[\d.,]+\s*(%|ms|s|kb|mb|gb|tb|x)?$/i;
const COMPACT_COL_MAX_WIDTH = 14;
const READABLE_COL_MIN_WIDTH = 12;
const HARD_COL_MIN_WIDTH = 3;

function normalizeCellText(value: string | number): string {
	return stripControl(String(value ?? ""), true)
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.join("\n");
}

function maxLineTextWidth(text: string): number {
	let maxW = 0;
	for (const line of text.split("\n")) {
		const lw = textWidth(line);
		if (lw > maxW) maxW = lw;
	}
	return maxW;
}

function allocateColumnWidths(naturalWidths: number[], availableWidth: number): number[] {
	const columnCount = naturalWidths.length;
	const widths = naturalWidths.slice();
	let totalWidth = widths.reduce((a, b) => a + b, 0);
	if (totalWidth <= availableWidth) return widths;

	const compactIndices: number[] = [];
	const wideIndices: number[] = [];
	naturalWidths.forEach((natW, i) => {
		if (natW <= COMPACT_COL_MAX_WIDTH) compactIndices.push(i);
		else wideIndices.push(i);
	});

	const compactTotal = compactIndices.reduce((sum, i) => sum + naturalWidths[i], 0);
	const minWideTotal = wideIndices.reduce((sum, i) => sum + Math.min(naturalWidths[i], READABLE_COL_MIN_WIDTH), 0);

	if (wideIndices.length > 0 && compactTotal + minWideTotal <= availableWidth) {
		const remainingForWide = availableWidth - compactTotal;
		const wideNaturalTotal = wideIndices.reduce((sum, i) => sum + naturalWidths[i], 0);
		for (const i of wideIndices) {
			const minW = Math.min(naturalWidths[i], READABLE_COL_MIN_WIDTH);
			const proportionalW = Math.floor((naturalWidths[i] / wideNaturalTotal) * remainingForWide);
			widths[i] = Math.max(minW, Math.min(naturalWidths[i], proportionalW));
		}
		let currentWideSum = wideIndices.reduce((sum, i) => sum + widths[i], 0);
		while (currentWideSum < remainingForWide) {
			let bestIdx = -1;
			let bestDeficit = -1;
			for (const i of wideIndices) {
				const deficit = naturalWidths[i] - widths[i];
				if (deficit > bestDeficit) {
					bestDeficit = deficit;
					bestIdx = i;
				}
			}
			if (bestIdx < 0 || bestDeficit <= 0) break;
			widths[bestIdx]++;
			currentWideSum++;
		}
		while (currentWideSum > remainingForWide) {
			let widestIdx = wideIndices[0];
			for (const i of wideIndices) {
				if (widths[i] > widths[widestIdx]) widestIdx = i;
			}
			const floorW = Math.min(naturalWidths[widestIdx], READABLE_COL_MIN_WIDTH);
			if (widths[widestIdx] <= floorW) break;
			widths[widestIdx]--;
			currentWideSum--;
		}
		return widths;
	}

	const floorWidth = availableWidth >= READABLE_COL_MIN_WIDTH * columnCount ? READABLE_COL_MIN_WIDTH : HARD_COL_MIN_WIDTH;
	while (totalWidth > availableWidth) {
		let k = 0;
		for (let i = 1; i < columnCount; i++) if (widths[i] > widths[k]) k = i;
		if (widths[k] <= floorWidth) break;
		widths[k]--;
		totalWidth--;
	}
	return widths;
}

export function tableBlock(columns: string[], rows: Array<Array<string | number>>, width: number): { block: Block; anchors: TableAnchors } {
	const n = Math.max(1, columns.length);
	const heads = columns.map((col) => oneLine(col));
	const data = rows.map((r) => columns.map((_, i) => normalizeCellText(r[i] ?? "")));
	const numeric = heads.map((_, i) => data.length > 0 && data.every((r) => r[i] === "" || (!r[i].includes("\n") && NUMERIC.test(r[i]))));
	const nat = heads.map((h, i) => Math.max(textWidth(h), ...data.map((r) => maxLineTextWidth(r[i])), 1));
	const avail = Math.max(n, width - (3 * n + 1));
	const w = allocateColumnWidths(nat, avail);
	const total = w.reduce((a, b) => a + b, 0) + 3 * n + 1;

	const borderLine = (l: string, m: string, r: string): Cell[] => {
		const out: Cell[] = [cell(l, "table.border")];
		w.forEach((cw, i) => {
			for (let k = 0; k < cw + 2; k++) out.push(cell("─", "table.border"));
			out.push(cell(i === n - 1 ? r : m, "table.border"));
		});
		return out;
	};

	const renderWrappedBand = (wrappedCols: Cell[][][], align: boolean[]): Cell[][] => {
		const bandHeight = Math.max(1, ...wrappedCols.map((lines) => lines.length));
		const bandRows: Cell[][] = [];
		for (let lineIdx = 0; lineIdx < bandHeight; lineIdx++) {
			const rowOut: Cell[] = [cell("│", "table.border")];
			w.forEach((cw, colIdx) => {
				const subLine = wrappedCols[colIdx]?.[lineIdx] ?? [];
				const pad = Math.max(0, cw - subLine.length);
				rowOut.push(cell(" "));
				if (align[colIdx]) for (let k = 0; k < pad; k++) rowOut.push(cell(" "));
				rowOut.push(...subLine);
				if (!align[colIdx]) for (let k = 0; k < pad; k++) rowOut.push(cell(" "));
				rowOut.push(cell(" "), cell("│", "table.border"));
			});
			bandRows.push(rowOut);
		}
		return bandRows;
	};

	const headWrapped = heads.map((h, i) => wrapText(h, w[i], "table.head"));
	const headRows = renderWrappedBand(headWrapped, heads.map(() => false));
	const headH = headRows.length;

	const dataWrapped = data.map((r) => r.map((v, i) => wrapText(v, w[i], "")));
	const rowHeights = dataWrapped.map((cols) => Math.max(1, ...cols.map((lines) => lines.length)));
	const hasMultiLineRow = rowHeights.some((h) => h > 1);

	const out: Cell[][] = [borderLine("┌", "┬", "┐"), ...headRows, borderLine("├", "┼", "┤")];
	const rowY: number[] = [];

	dataWrapped.forEach((wrappedCols, ri) => {
		rowY.push(out.length);
		out.push(...renderWrappedBand(wrappedCols, numeric));
		if (hasMultiLineRow && ri < dataWrapped.length - 1) {
			out.push(borderLine("├", "┼", "┤"));
		}
	});
	out.push(borderLine("└", "┴", "┘"));

	const colX: number[] = [];
	let x = 1;
	w.forEach((cw) => {
		colX.push(x + 1);
		x += cw + 3;
	});
	const anchors: TableAnchors = {
		cols: w.map((cw, i) => ({ x: colX[i], y: 1, w: cw, h: headH })),
		rows: data.map((_, ri) => ({ x: 0, y: rowY[ri], w: total, h: rowHeights[ri] })),
		cells: data.map((_, ri) => w.map((cw, i) => ({ x: colX[i], y: rowY[ri], w: cw, h: rowHeights[ri] }))),
	};
	return { block: fromRows(total, out.map((r) => padRow(r, total))), anchors };
}
