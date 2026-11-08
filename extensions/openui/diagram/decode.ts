// Test oracle: recover the wires of a rendered diagram from its glyphs alone.
// It shares no code with the router: it only looks at DiagramResult.rows and the node rectangles.

import type { DiagramResult } from "./layeredDiagram.ts";
import { MANY_END, ONE_END } from "./wires.ts";

const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
const OPP = [2, 3, 0, 1];
const BIT = [1, 2, 4, 8];

const CONN: Record<string, number> = {
	"│": 5,
	"┆": 5,
	"─": 10,
	"┄": 10,
	"╭": 6,
	"╮": 12,
	"╰": 3,
	"╯": 9,
	"┼": 15,
};
const ARROW_POINTS: Record<string, number> = { "▲": 0, "▶": 1, "▼": 2, "◀": 3 };
const JUNCTION_SIDE: Record<string, number> = { "┴": 0, "├": 1, "┬": 2, "┤": 3 }; // outward normal of the border cell

export type EndKind = "attach" | "arrow" | "dot" | "one" | "many";

export interface WireEnd {
	node: number;
	side: number;
	kind: EndKind;
}

export interface DecodedWire {
	a: WireEnd;
	b: WireEnd;
	cells: number;
}

export interface Decoded {
	wires: DecodedWire[];
	/** wire-like cells that no walk reached */
	stray: Array<[number, number]>;
	/** walks that ended somewhere that is not a box */
	broken: number;
	/** where each broken walk started and stopped */
	brokenInfo: string[];
}

export function decodeWires(res: DiagramResult): Decoded {
	const rows = res.rows;
	const H = rows.length;
	const W = H ? rows[0].length : 0;
	const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < W && y < H ? rows[y][x] : { ch: " ", role: "" });
	const nodeAt = (x: number, y: number): number => {
		for (let i = 0; i < res.nodes.length; i++) {
			const r = res.nodes[i].rect;
			if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return i;
		}
		return -1;
	};
	const visited = new Set<number>();
	const wires: Array<{ key: string; wire: DecodedWire }> = [];
	let broken = 0;
	const brokenInfo: string[] = [];

	type Start = { end: WireEnd; x: number; y: number; px: number; py: number };
	const starts: Start[] = [];
	res.nodes.forEach((n, ni) => {
		const r = n.rect;
		for (let side = 0; side < 4; side++) {
			const cells: Array<[number, number]> = [];
			if (side === 0 || side === 2) for (let x = r.x + 1; x <= r.x + r.w - 2; x++) cells.push([x, side === 0 ? r.y - 1 : r.y + r.h]);
			else for (let y = r.y + 1; y <= r.y + r.h - 2; y++) cells.push([side === 1 ? r.x + r.w : r.x - 1, y]);
			for (const [x, y] of cells) {
				const c = at(x, y);
				if (c.role === "arrow" && ARROW_POINTS[c.ch] === OPP[side]) starts.push({ end: { node: ni, side, kind: "arrow" }, x, y, px: x, py: y });
				else if (c.role === "mark" && (c.ch === "●" || c.ch === ONE_END[OPP[side]] || c.ch === MANY_END[OPP[side]])) {
					const kind: EndKind = c.ch === "●" ? "dot" : c.ch === MANY_END[OPP[side]] ? "many" : "one";
					starts.push({ end: { node: ni, side, kind }, x, y, px: x, py: y });
				} else if (c.role.startsWith("wire")) {
					const bxx = x + DX[OPP[side]];
					const byy = y + DY[OPP[side]];
					const b = at(bxx, byy);
					if (JUNCTION_SIDE[b.ch] === side && nodeAt(bxx, byy) === ni) starts.push({ end: { node: ni, side, kind: "attach" }, x, y, px: x, py: y });
				}
			}
		}
	});

	for (const st of starts) {
		let x = st.x;
		let y = st.y;
		let d = st.end.side; // travel direction: away from the box
		let count = 0;
		if (st.end.kind !== "attach") {
			visited.add(y * W + x);
			x += DX[d];
			y += DY[d];
		}
		let guard = W * H * 4 + 16;
		let result: WireEnd | null = null;
		let resultCell = "";
		while (guard-- > 0) {
			const ni = nodeAt(x, y);
			if (ni >= 0) {
				// arrived at a box border: only valid for an attach end
				const side = OPP[d];
				const b = at(x, y);
				if (JUNCTION_SIDE[b.ch] === side) {
					result = { node: ni, side, kind: "attach" };
					resultCell = `${x - DX[d]},${y - DY[d]}`;
				}
				break;
			}
			const c = at(x, y);
			visited.add(y * W + x);
			count++;
			if (c.role === "arrow" && c.ch in ARROW_POINTS) {
				if (ARROW_POINTS[c.ch] !== d) break;
				const nx = nodeAt(x + DX[d], y + DY[d]);
				if (nx >= 0) {
					result = { node: nx, side: OPP[d], kind: "arrow" };
					resultCell = `${x},${y}`;
				}
				break;
			}
			if (c.role === "mark") {
				const nx = nodeAt(x + DX[d], y + DY[d]);
				if (nx < 0) break;
				let kind: EndKind | null = null;
				if (c.ch === "●") kind = "dot";
				else if (c.ch === MANY_END[d]) kind = "many";
				else if (c.ch === ONE_END[d]) kind = "one";
				if (!kind) break; // a mark that does not face the box it touches is not a valid end
				result = { node: nx, side: OPP[d], kind };
				resultCell = `${x},${y}`;
				break;
			}
			if (c.role === "elabel") {
				x += DX[d];
				y += DY[d];
				continue;
			}
			const bits = c.role.startsWith("wire") ? (CONN[c.ch] ?? 0) : 0;
			if (!bits || !(bits & BIT[OPP[d]])) break;
			if (c.ch === "┼") {
				x += DX[d];
				y += DY[d];
				continue;
			}
			const exits = bits & ~BIT[OPP[d]];
			let nd = -1;
			for (let k = 0; k < 4; k++) if (exits === BIT[k]) nd = k;
			if (nd < 0) break;
			d = nd;
			x += DX[d];
			y += DY[d];
		}
		if (!result) {
			broken++;
			brokenInfo.push(`start node ${res.nodes[st.end.node].id} side ${st.end.side} kind ${st.end.kind} at ${st.px},${st.py}; stopped at ${x},${y} glyph '${at(x, y).ch}' role '${at(x, y).role}' dir ${d}`);
			continue;
		}
		wires.push({ key: [`${st.px},${st.py}`, resultCell].sort().join("|"), wire: { a: st.end, b: result, cells: count } });
	}
	// every wire is seen from both ends: keep one per pair of end cells
	const seen = new Set<string>();
	const uniq: DecodedWire[] = [];
	for (const { key, wire } of wires) {
		if (seen.has(key)) continue;
		seen.add(key);
		uniq.push(wire);
	}
	const stray: Array<[number, number]> = [];
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const c = rows[y][x];
			const wireLike = c.role.startsWith("wire") || c.role === "arrow" || c.role === "mark" || c.role === "elabel";
			if (wireLike && !visited.has(y * W + x)) stray.push([x, y]);
		}
	return { wires: uniq, stray, broken, brokenInfo };
}

/** Edges as "from>to" keys, for graphs whose edges are drawn with an arrow at one end and an attached start. */
export function decodeDirected(res: DiagramResult): { edges: Set<string>; problems: string[]; decoded: Decoded } {
	const decoded = decodeWires(res);
	const edges = new Set<string>();
	const problems: string[] = [];
	for (const w of decoded.wires) {
		const kinds = [w.a.kind, w.b.kind];
		const ai = kinds.indexOf("arrow");
		const ti = kinds.indexOf("attach");
		if (kinds.filter((k) => k === "arrow").length === 1 && kinds.filter((k) => k === "attach").length === 1) {
			const to = ai === 0 ? w.a : w.b;
			const from = ti === 0 ? w.a : w.b;
			const key = `${res.nodes[from.node].id}>${res.nodes[to.node].id}`;
			if (edges.has(key)) problems.push(`duplicate wire ${key}`);
			edges.add(key);
		} else problems.push(`wire with ends ${kinds.join("/")} between ${res.nodes[w.a.node].id} and ${res.nodes[w.b.node].id}`);
	}
	if (decoded.broken) problems.push(`${decoded.broken} broken walk(s)`);
	if (decoded.stray.length) problems.push(`${decoded.stray.length} stray wire cell(s)`);
	return { edges, problems, decoded };
}

/** Relations as sorted "idA:kindA~idB:kindB" keys (kinds one/many), as a multiset. */
export function decodeRelations(res: DiagramResult): { keys: string[]; problems: string[]; decoded: Decoded } {
	const decoded = decodeWires(res);
	const keys: string[] = [];
	const problems: string[] = [];
	for (const w of decoded.wires) {
		const ok = (k: EndKind) => k === "one" || k === "many";
		if (!ok(w.a.kind) || !ok(w.b.kind)) {
			problems.push(`wire with ends ${w.a.kind}/${w.b.kind}`);
			continue;
		}
		keys.push([`${res.nodes[w.a.node].id}:${w.a.kind}`, `${res.nodes[w.b.node].id}:${w.b.kind}`].sort().join("~"));
	}
	if (decoded.broken) problems.push(`${decoded.broken} broken walk(s): ${decoded.brokenInfo.join(" | ")}`);
	if (decoded.stray.length) problems.push(`${decoded.stray.length} stray cell(s)`);
	return { keys: keys.sort(), problems, decoded };
}

/** Links drawn with a dot at the source and an arrowhead at the target, as "from>to" keys (multiset). */
export function decodeLinks(res: DiagramResult): { keys: string[]; problems: string[]; decoded: Decoded } {
	const decoded = decodeWires(res);
	const keys: string[] = [];
	const problems: string[] = [];
	for (const w of decoded.wires) {
		const kinds = [w.a.kind, w.b.kind];
		if (kinds.includes("dot") && kinds.includes("arrow") && kinds[0] !== kinds[1]) {
			const from = w.a.kind === "dot" ? w.a : w.b;
			const to = w.a.kind === "arrow" ? w.a : w.b;
			keys.push(`${res.nodes[from.node].id}>${res.nodes[to.node].id}`);
		} else problems.push(`wire with ends ${kinds.join("/")}`);
	}
	if (decoded.broken) problems.push(`${decoded.broken} broken walk(s): ${decoded.brokenInfo.join(" | ")}`);
	if (decoded.stray.length) problems.push(`${decoded.stray.length} stray cell(s)`);
	return { keys: keys.sort(), problems, decoded };
}
