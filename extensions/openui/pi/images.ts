// Pictures for the Image component. pi-tui's own Image does the sizing and the Kitty encoding (so cell maths, image ids
// and the alt-screen cropping metadata are pi's), this file loads the bytes and keeps the placements.
// Security-hardened: local paths are strictly confined to the workspace with a 256-byte magic-byte probe before full read,
// and data: URIs are magic-byte probed on a 256-byte prefix before full base64 decode.
import { getCapabilities, getImageDimensions, Image } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ImageService } from "../blocks/types.ts";
import { GENERIC_IMAGE_ERROR, resolveWorkspaceImagePath, sniffImageMime, stripControl } from "../security.ts";

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_DATA_URI_B64_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64;

export interface LoadedImage {
	base64: string;
	mime: string;
	name: string;
	bytes: number;
	dims: { widthPx: number; heightPx: number } | null;
}

const cache = new Map<string, { stamp: string; value: LoadedImage | { error: string } }>();
/**
 * Pictures are kept as base64 (a file of 12 MB is 16 MB of string), so the cache is bounded by size, not by count: 32 large
 * screenshots would otherwise pin half a gigabyte for as long as pi runs.
 */
const CACHE_BUDGET = 48 * 1024 * 1024;
let cacheBytes = 0;
const weigh = (v: LoadedImage | { error: string }) => ("base64" in v ? v.base64.length : 0);

export function imageCacheStats() {
	return { entries: cache.size, bytes: cacheBytes, budget: CACHE_BUDGET };
}

function remember(path: string, stamp: string, value: LoadedImage | { error: string }) {
	const old = cache.get(path);
	if (old) cacheBytes -= weigh(old.value);
	cache.delete(path);
	cache.set(path, { stamp, value });
	cacheBytes += weigh(value);
	for (const [k, v] of cache) {
		if (cache.size <= 1 || (cache.size <= 32 && cacheBytes <= CACHE_BUDGET)) break;
		cache.delete(k);
		cacheBytes -= weigh(v.value);
	}
}

/**
 * Read a workspace-confined local file or a base64 data: URI. Never throws, and never leaks out-of-workspace file existence or size.
 */
export function loadImage(src: string, cwd: string = process.cwd()): LoadedImage | { error: string } {
	const s = String(src ?? "").trim();
	if (!s) return { error: GENERIC_IMAGE_ERROR };
	if (/^(?:https?|file):/i.test(s)) return { error: GENERIC_IMAGE_ERROR };

	if (s.startsWith("data:")) {
		const m = /^data:([^;,]*)(;[^,]*)?,(.*)$/s.exec(s);
		if (!m || !/;base64/i.test(m[2] ?? "")) return { error: GENERIC_IMAGE_ERROR };
		const b64Payload = m[3].replace(/\s+/g, "");
		if (!b64Payload || b64Payload.length > MAX_DATA_URI_B64_CHARS) {
			return { error: GENERIC_IMAGE_ERROR };
		}
		// Probe only the first 256 bytes (344 base64 chars) before allocating the full buffer
		let probe: Buffer;
		try {
			probe = Buffer.from(b64Payload.slice(0, 352), "base64");
		} catch {
			return { error: GENERIC_IMAGE_ERROR };
		}
		const probeMime = sniffImageMime(probe);
		if (!probeMime) {
			return { error: GENERIC_IMAGE_ERROR };
		}
		let buf: Buffer;
		try {
			buf = Buffer.from(b64Payload, "base64");
		} catch {
			return { error: GENERIC_IMAGE_ERROR };
		}
		if (buf.length <= 0 || buf.length > MAX_IMAGE_BYTES) {
			return { error: GENERIC_IMAGE_ERROR };
		}
		const ext = probeMime.split("/")[1] ?? "png";
		return decode(buf, `inline.${ext}`, probeMime);
	}

	const resolved = resolveWorkspaceImagePath(s, cwd);
	if (!resolved.ok) {
		return { error: GENERIC_IMAGE_ERROR };
	}

	const stamp = `${resolved.mtimeMs}:${resolved.size}`;
	const hit = cache.get(resolved.realPath);
	if (hit && hit.stamp === stamp) return hit.value;

	let buf: Buffer;
	try {
		buf = readFileSync(resolved.realPath);
	} catch {
		return { error: GENERIC_IMAGE_ERROR };
	}
	if (buf.length <= 0 || buf.length > MAX_IMAGE_BYTES) {
		return { error: GENERIC_IMAGE_ERROR };
	}

	const name = stripControl(basename(resolved.realPath), false) || "image";
	const value = decode(buf, name, resolved.mime);
	remember(resolved.realPath, stamp, value);
	return value;
}

function decode(buf: Buffer, name: string, verifiedMime?: string): LoadedImage | { error: string } {
	const mime = verifiedMime ?? sniffImageMime(buf);
	if (!mime) {
		return { error: GENERIC_IMAGE_ERROR };
	}
	const base64 = buf.toString("base64");
	return { base64, mime, name, bytes: buf.length, dims: getImageDimensions(base64, mime) };
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

interface Placement {
	sequence: string;
	cols: number;
	rows: number;
}

function hash(s: string): string {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return (h >>> 0).toString(36) + s.length.toString(36);
}

export interface PiImageService extends ImageService {
	/** The terminal sequence that draws a placed image (the first line pi-tui's Image returns). */
	sequence(key: string): string | null;
	/** Called after a picture that could not be drawn yet becomes drawable (pi loads its JPEG/GIF/WebP converter lazily). */
	onLate: (() => void) | null;
	/** Forget every placement: the terminal reported another cell size, so the same picture now needs other columns and rows. */
	reset(): void;
	/** Update the active workspace directory used for confining local image paths. */
	setCwd(cwd: string): void;
}

export function createImageService(initialCwd: string = process.cwd()): PiImageService {
	const placements = new Map<string, Placement>();
	const pending = new Map<string, number>();
	let activeCwd = initialCwd;
	let placedChars = 0;
	const svc: PiImageService = {
		onLate: null,
		setCwd(cwd: string) {
			if (typeof cwd !== "string") return;
			const next = cwd.trim();
			if (next && next !== activeCwd) {
				activeCwd = next;
				this.reset();
			}
		},
		reset() {
			placements.clear();
			pending.clear();
			placedChars = 0;
		},
		sequence: (key) => placements.get(key)?.sequence ?? null,
		describe(src) {
			const img = loadImage(src, activeCwd);
			if ("error" in img) return img.error;
			const fmt = img.mime.split("/")[1];
			return [img.name, img.dims ? `${img.dims.widthPx}×${img.dims.heightPx}` : "", fmt, kb(img.bytes)].filter(Boolean).join(" · ");
		},
		place(src, maxCols, maxRows) {
			if (getCapabilities().images !== "kitty") return null;
			const img = loadImage(src, activeCwd);
			if ("error" in img) return null;
			const key = `${hash(activeCwd + "\0" + src)}:${hash(img.base64)}:${maxCols}x${maxRows}`;
			let p = placements.get(key);
			if (!p) {
				const comp = new Image(img.base64, img.mime, { fallbackColor: (s: string) => s }, { maxWidthCells: maxCols, maxHeightCells: maxRows, filename: img.name }, img.dims ?? undefined);
				const lines = comp.render(maxCols + 2);
				const seq = lines[0] ?? "";
				if (!seq.includes("\x1b_G")) {
					const tries = pending.get(key) ?? 0;
					if (tries < 8 && img.mime !== "image/png") {
						pending.set(key, tries + 1);
						const t = setTimeout(() => svc.onLate?.(), 350);
						if (typeof (t as any).unref === "function") (t as any).unref();
					}
					return null;
				}
				const c = /\x1b_G[^;]*,c=(\d+)/.exec(seq);
				p = { sequence: seq, cols: c ? Number(c[1]) : maxCols, rows: lines.length };
				placements.set(key, p);
				placedChars += p.sequence.length;
				for (const [k, old] of placements) {
					if (placements.size <= 1 || (placements.size <= 40 && placedChars <= CACHE_BUDGET)) break;
					placements.delete(k);
					placedChars -= old.sequence.length;
				}
			}
			return { key, cols: p.cols, rows: p.rows };
		},
	};
	return svc;
}

export const imageService = createImageService();
