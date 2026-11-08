// Centralized security & trust-boundary module for the OpenUI extension.
// Zero external dependencies (defense-in-depth with @earendil-works/pi-tui when available).
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import * as piTui from "@earendil-works/pi-tui";

export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export function isSafeKey(key: string): boolean {
	return typeof key === "string" && !FORBIDDEN_KEYS.has(key);
}

export function createNullMap<T = any>(): Record<string, T> {
	return Object.create(null) as Record<string, T>;
}

const ANSI_ESCAPE_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|_[G-Z]?[^\x1b]*(?:\x1b\\|\x07)|[PX^][^\x1b]*(?:\x1b\\|\x07)|[@-Z\\-_])/g;

const tuiStrip: ((s: string) => string) | null =
	typeof (piTui as any).stripTerminalSequences === "function" ? (piTui as any).stripTerminalSequences : null;

/**
 * Strip terminal escape sequences (CSI, OSC, APC/Kitty, DCS), C0/C1 control characters (\p{Cc}),
 * DEL (\x7f), Unicode format/bidi/zero-width characters (\p{Cf}), and line/paragraph separators (\u2028, \u2029).
 * When `allowNewlines` is true, `\n` is preserved and `\t` is converted to two spaces; otherwise both become spaces.
 */
export function stripControl(raw: unknown, allowNewlines = false): string {
	if (raw == null) return "";
	let text = String(raw).replace(/\r\n?/g, "\n");
	text = text.replace(ANSI_ESCAPE_RE, "");
	if (tuiStrip) {
		try {
			text = tuiStrip(text);
		} catch {
			// ignore fallback errors
		}
	}
	return text.replace(/[\p{Cc}\p{Cf}\x7f\u2028\u2029]/gu, (ch) => {
		if (ch === "\n") return allowNewlines ? "\n" : " ";
		if (ch === "\t") return allowNewlines ? "  " : " ";
		return "";
	});
}

const SLASH_COMMAND_RE = /^\/[^\s/]*(?:\s|$)/;

/** True when a line starts with `/command`, which Pi or other hosts could interpret as a slash command. */
export function runsAsCommand(text: string): boolean {
	return SLASH_COMMAND_RE.test(String(text ?? "").trim());
}

/**
 * Neutralize untrusted or semi-trusted text before it can enter user messages or the editor:
 * 1. Strips control/ANSI/bidi sequences via `stripControl`.
 * 2. Rewrites `(^|\s)@(?=\S)` to `$1(at)` so Pi never auto-attaches `@file` references.
 * 3. Defuses leading `/command` lines so slash commands cannot be invoked.
 */
export function neutralizePrompt(raw: unknown, opts?: { allowNewlines?: boolean; prefixCommand?: string }): string {
	const allowNewlines = opts?.allowNewlines ?? true;
	const prefixCommand = opts?.prefixCommand ?? "[Widget action] ";
	let cleaned = stripControl(raw, allowNewlines);
	cleaned = cleaned.replace(/(^|\s)@(?=\S)/g, "$1(at)");

	if (!allowNewlines) {
		if (runsAsCommand(cleaned)) {
			return prefixCommand ? `${prefixCommand}${cleaned.trimStart()}` : cleaned.replace(/^(\s*)\//, "$1(slash)/");
		}
		return cleaned;
	}

	const lines = cleaned.split("\n");
	let seenNonEmpty = false;
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (!trimmed) continue;
		if (!seenNonEmpty) {
			seenNonEmpty = true;
			if (runsAsCommand(trimmed)) {
				lines[i] = prefixCommand ? `${prefixCommand}${lines[i].trimStart()}` : lines[i].replace(/^(\s*)\//, "$1(slash)/");
			}
		} else if (runsAsCommand(trimmed)) {
			lines[i] = lines[i].replace(/^(\s*)\//, "$1(slash)/");
		}
	}
	return lines.join("\n");
}

const URL_ERROR = "URL must be a valid http:// or https:// link (at most 2000 characters)";

/** Validate that a URL is a clean `http:` or `https:` URL within `maxLen` characters. */
export function validateSafeUrl(raw: unknown, maxLen = 2000): { ok: true; url: string } | { ok: false; error: string } {
	if (typeof raw !== "string") return { ok: false, error: URL_ERROR };
	if (raw.length === 0 || raw.length > maxLen) return { ok: false, error: URL_ERROR };
	if (/[\p{Cc}\p{Cf}\x7f\u2028\u2029]/u.test(raw)) return { ok: false, error: URL_ERROR };
	const trimmed = raw.trim();
	if (!trimmed || trimmed.length > maxLen || /\s/.test(trimmed)) return { ok: false, error: URL_ERROR };
	try {
		const parsed = new URL(trimmed);
		if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || !parsed.hostname) {
			return { ok: false, error: URL_ERROR };
		}
		return { ok: true, url: trimmed };
	} catch {
		return { ok: false, error: URL_ERROR };
	}
}

export const GENERIC_IMAGE_ERROR = "Image unavailable (must be a valid PNG/JPEG/GIF/WebP inside the current workspace)";
const MAX_WORKSPACE_IMAGE_BYTES = 12 * 1024 * 1024;

/** Sniff the first 12 bytes of a buffer for PNG, JPEG, GIF, or WebP magic headers. */
export function sniffImageMime(header: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
	if (
		header.length >= 8 &&
		header[0] === 0x89 &&
		header[1] === 0x50 &&
		header[2] === 0x4e &&
		header[3] === 0x47 &&
		header[4] === 0x0d &&
		header[5] === 0x0a &&
		header[6] === 0x1a &&
		header[7] === 0x0a
	) {
		return "image/png";
	}
	if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
		return "image/jpeg";
	}
	if (
		header.length >= 6 &&
		header[0] === 0x47 &&
		header[1] === 0x49 &&
		header[2] === 0x46 &&
		header[3] === 0x38 &&
		(header[4] === 0x37 || header[4] === 0x39) &&
		header[5] === 0x61
	) {
		return "image/gif";
	}
	if (
		header.length >= 12 &&
		header[0] === 0x52 &&
		header[1] === 0x49 &&
		header[2] === 0x46 &&
		header[3] === 0x46 &&
		header[8] === 0x57 &&
		header[9] === 0x45 &&
		header[10] === 0x42 &&
		header[11] === 0x50
	) {
		return "image/webp";
	}
	return null;
}

function isContainedInWorkspace(realCwd: string, realTarget: string): boolean {
	const rel = relative(realCwd, realTarget);
	if (rel === "" || rel === "." || rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("../") || isAbsolute(rel)) return false;
	if (process.platform === "win32") {
		const normCwd = realCwd.toLowerCase().replace(/[\\/]+$/, "");
		const normTarget = realTarget.toLowerCase();
		if (!normTarget.startsWith(normCwd + sep)) return false;
	}
	return true;
}

/**
 * Resolve a local image path strictly inside `cwd`, following symlinks via `realpathSync`,
 * checking regular file status & size (`<= 12 MB`), and probing only the first 256 bytes for magic headers.
 */
export function resolveWorkspaceImagePath(
	src: string,
	cwd: string,
): { ok: true; realPath: string; size: number; mtimeMs: number; mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp" } | { ok: false; error: string } {
	if (typeof src !== "string" || typeof cwd !== "string") return { ok: false, error: GENERIC_IMAGE_ERROR };
	const trimmed = src.trim();
	if (!trimmed || trimmed.includes("\0")) return { ok: false, error: GENERIC_IMAGE_ERROR };
	if (/^(?:https?|file):/i.test(trimmed) || trimmed.startsWith("~/") || trimmed.startsWith("~\\") || trimmed === "~") {
		return { ok: false, error: GENERIC_IMAGE_ERROR };
	}

	let realCwd: string;
	let realTarget: string;
	try {
		const candidate = resolve(cwd, trimmed);
		realCwd = realpathSync(cwd);
		realTarget = realpathSync(candidate);
	} catch {
		return { ok: false, error: GENERIC_IMAGE_ERROR };
	}

	if (!isContainedInWorkspace(realCwd, realTarget)) {
		return { ok: false, error: GENERIC_IMAGE_ERROR };
	}

	let st;
	try {
		st = statSync(realTarget);
	} catch {
		return { ok: false, error: GENERIC_IMAGE_ERROR };
	}
	if (!st.isFile() || st.size <= 0 || st.size > MAX_WORKSPACE_IMAGE_BYTES) {
		return { ok: false, error: GENERIC_IMAGE_ERROR };
	}

	const probeBuf = Buffer.alloc(256);
	let bytesRead = 0;
	let fd: number | null = null;
	try {
		fd = openSync(realTarget, "r");
		bytesRead = readSync(fd, probeBuf, 0, 256, 0);
	} catch {
		return { ok: false, error: GENERIC_IMAGE_ERROR };
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				// ignore close error
			}
		}
	}

	const mime = sniffImageMime(probeBuf.subarray(0, bytesRead));
	if (!mime) {
		return { ok: false, error: GENERIC_IMAGE_ERROR };
	}

	return { ok: true, realPath: realTarget, size: st.size, mtimeMs: st.mtimeMs, mime };
}

/**
 * Resolve a workspace file path (e.g. for `/openui-file`), enforcing `realpathSync` containment inside `cwd`
 * and bounding size by `maxBytes`.
 */
export function resolveWorkspaceFilePath(rawPath: string, cwd: string, maxBytes: number): { ok: true; realPath: string } | { ok: false; error: string } {
	if (typeof rawPath !== "string" || typeof cwd !== "string") {
		return { ok: false, error: "File must be a valid path inside the current workspace" };
	}
	const trimmed = rawPath.trim();
	if (!trimmed || trimmed.includes("\0") || trimmed.startsWith("~/") || trimmed.startsWith("~\\") || trimmed === "~") {
		return { ok: false, error: "File must be inside the current workspace" };
	}

	let realCwd: string;
	let realTarget: string;
	try {
		const candidate = resolve(cwd, trimmed);
		realCwd = realpathSync(cwd);
		realTarget = realpathSync(candidate);
	} catch {
		return { ok: false, error: "File not found inside the current workspace" };
	}

	if (!isContainedInWorkspace(realCwd, realTarget)) {
		return { ok: false, error: "File must be inside the current workspace" };
	}

	try {
		const st = statSync(realTarget);
		if (!st.isFile()) return { ok: false, error: "Path is not a regular file" };
		if (st.size > maxBytes) return { ok: false, error: `File exceeds the ${Math.round(maxBytes / 1000)} KB limit` };
	} catch {
		return { ok: false, error: "File could not be read" };
	}

	return { ok: true, realPath: realTarget };
}
