import { realpathSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import * as path from "node:path";
import {
	getAgentDir,
	getPackageDir,
	isEditToolResult,
	isToolCallEventType,
	isWriteToolResult,
	type AutocompleteItem,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Key,
	isKeyRelease,
	isKeyRepeat,
	matchesKey,
	replaceControlCharacters,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
	type OverlayOptions,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

// ============================================================================
// Step 1: Constants, Runtime `diff` Resolution & Core Data Types
// ============================================================================

export const BASELINE_ENTRY_TYPE = "session-diff-baseline";
export const TOUCH_ENTRY_TYPE = "session-diff-touch";
export const SESSION_DIFF_SHORTCUT = Key.ctrlAlt("d");
export const MAX_SNAPSHOT_BYTES = 512 * 1024; // 512 KB
export const BINARY_PROBE_BYTES = 8 * 1024; // 8 KB
export const CONTEXT_LINES = 3;
export const MIN_SIDE_BY_SIDE_WIDTH = 80;
export const TAB_REPLACEMENT = "    "; // 4 spaces
export const SPOOL_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
export const OVERLAY_OPEN_CLOSE_GUARD_MS = 400;
export const OVERLAY_OPEN_ESCAPE_GUARD_MS = 180;
export const SHORTCUT_REPEAT_BURST_GAP_MS = 220;
export const MOUSE_WHEEL_SCROLL_LINES = 3;
export const ENABLE_MOUSE_TRACKING_SEQ = "\x1b[?1000h\x1b[?1006h";
export const DISABLE_MOUSE_TRACKING_SEQ = "\x1b[?1006l\x1b[?1000l";

export interface ParsedMouseWheelEvent {
	direction: -1 | 1;
	alt: boolean;
	shift: boolean;
	ctrl: boolean;
}

export function parseMouseWheelInput(
	data: string,
): ParsedMouseWheelEvent | "mouse-other" | undefined {
	if (!data.startsWith("\x1b[")) {
		return undefined;
	}

	// SGR extended mouse mode: \x1b[<Cb;Cx;CyM or \x1b[<Cb;Cx;Cym
	const sgrMatch = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (sgrMatch) {
		if (sgrMatch[4] === "m") {
			return "mouse-other";
		}
		const button = Number.parseInt(sgrMatch[1], 10);
		if ((button & 64) !== 0) {
			const directionBits = button & 3;
			if (directionBits === 0 || directionBits === 1) {
				return {
					direction: directionBits === 0 ? -1 : 1,
					shift: (button & 4) !== 0,
					alt: (button & 8) !== 0,
					ctrl: (button & 16) !== 0,
				};
			}
		}
		return "mouse-other";
	}

	// X10 / normal mouse mode: \x1b[MCbCxCy (6 bytes)
	if (data.length === 6 && data.startsWith("\x1b[M")) {
		const button = data.charCodeAt(3) - 32;
		if ((button & 64) !== 0) {
			const directionBits = button & 3;
			if (directionBits === 0 || directionBits === 1) {
				return {
					direction: directionBits === 0 ? -1 : 1,
					shift: (button & 4) !== 0,
					alt: (button & 8) !== 0,
					ctrl: (button & 16) !== 0,
				};
			}
		}
		return "mouse-other";
	}

	// URXVT mouse mode: \x1b[Cb;Cx;CyM
	const urxvtMatch = data.match(/^\x1b\[(\d+);(\d+);(\d+)M$/);
	if (urxvtMatch) {
		const rawButton = Number.parseInt(urxvtMatch[1], 10);
		const button = rawButton >= 32 ? rawButton - 32 : rawButton;
		if ((button & 64) !== 0) {
			const directionBits = button & 3;
			if (directionBits === 0 || directionBits === 1) {
				return {
					direction: directionBits === 0 ? -1 : 1,
					shift: (button & 4) !== 0,
					alt: (button & 8) !== 0,
					ctrl: (button & 16) !== 0,
				};
			}
		}
		return "mouse-other";
	}

	return undefined;
}

export function matchesSessionDiffShortcutKey(data: string): boolean {
	return matchesKey(data, SESSION_DIFF_SHORTCUT) || matchesKey(data, "ctrl+alt+d");
}

export function isSessionDiffShortcut(data: string): boolean {
	if (isKeyRelease(data) || isKeyRepeat(data)) {
		return false;
	}
	return matchesSessionDiffShortcutKey(data);
}

export interface BaselineSnapshotEntry {
	relPath: string;
	existedBefore: boolean;
	oldContent: string | null;
	isBinary: boolean;
	tooLarge: boolean;
	byteLength: number;
	firstModifiedAt: number;
	firstTool?: "edit" | "write";
}

export interface TouchEntry {
	relPath: string;
	toolName: "edit" | "write";
	timestamp: number;
}

export type TrackedFileState = BaselineSnapshotEntry & {
	editCount: number;
	lastModifiedAt: number;
	lastTool: "edit" | "write";
};

export interface PendingCapture {
	relPath: string;
	absPath: string;
	toolName: "edit" | "write";
	baseline?: BaselineSnapshotEntry;
}

export interface SubagentSpoolRecord {
	id: string;
	pid: number;
	ppid: number;
	toolCallId: string;
	childCwd: string;
	absPath: string;
	toolName: "edit" | "write";
	timestamp: number;
	seq: number;
	baseline: BaselineSnapshotEntry;
}

interface PendingSubagentCall {
	toolCallId: string;
	toolName: "subagent" | "swarm_resume";
	startedAt: number;
	cwd: string;
}

export interface ExtractedSubagentFileOp {
	toolCallId: string;
	toolName: "edit" | "write";
	rawPath: string;
	cwd: string;
	timestamp: number;
	edits?: Array<{ oldText: string; newText: string }>;
	writeContent?: string;
}

export type FileStatus = "modified" | "added" | "deleted" | "reverted" | "binary" | "too-large";
export type ViewMode = "hunks" | "full";
export type LayoutMode = "split" | "unified";

export interface DiffPart {
	value: string;
	added?: boolean;
	removed?: boolean;
	count?: number;
}

export interface DiffEngine {
	diffLines(oldText: string, newText: string): DiffPart[];
	diffWords(oldText: string, newText: string): DiffPart[];
}

export interface FileSnapshotProbe {
	exists: boolean;
	content: string | null;
	isBinary: boolean;
	tooLarge: boolean;
	byteLength: number;
}

export interface WordSegment {
	text: string;
	highlight: boolean;
}

export interface DiffCell {
	type: "context" | "removed" | "added" | "filler";
	lineNo: number | null;
	rawText: string;
	wordSegments?: WordSegment[];
}

export interface AlignedDiffRow {
	left: DiffCell;
	right: DiffCell;
	isChanged: boolean;
}

export interface DiffHunkRange {
	header: string;
	startRowIndex: number;
	endRowIndex: number;
	firstChangedRowIndex: number;
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
}

export interface ComputedFileDiff {
	relPath: string;
	absPath: string;
	status: FileStatus;
	addedLines: number;
	removedLines: number;
	maxLineNumber: number;
	oldByteLength: number;
	newByteLength: number;
	editCount: number;
	lastTool: "edit" | "write";
	lastModifiedAt: number;
	revisionKey: string;
	alignedRows: AlignedDiffRow[];
	hunks: DiffHunkRange[];
}

interface CachedRenderBody {
	lines: string[];
	hunkLineOffsets: number[];
}

/**
 * Lightweight LCS-based fallback for `diffLines` and `diffWords` when running in a
 * standalone single-file binary without external `node_modules/diff`.
 */
function computeLcsDiffParts(oldTokens: string[], newTokens: string[]): DiffPart[] {
	const oldLen = oldTokens.length;
	const newLen = newTokens.length;
	if (oldLen === 0 && newLen === 0) {
		return [];
	}
	if (oldLen === 0) {
		return [{ value: newTokens.join(""), added: true, count: newLen }];
	}
	if (newLen === 0) {
		return [{ value: oldTokens.join(""), removed: true, count: oldLen }];
	}

	// Trim common prefix and suffix to keep matrix small on large inputs
	let start = 0;
	while (start < oldLen && start < newLen && oldTokens[start] === newTokens[start]) {
		start++;
	}
	let oldEnd = oldLen - 1;
	let newEnd = newLen - 1;
	while (oldEnd >= start && newEnd >= start && oldTokens[oldEnd] === newTokens[newEnd]) {
		oldEnd--;
		newEnd--;
	}

	const rawParts: DiffPart[] = [];
	if (start > 0) {
		rawParts.push({ value: oldTokens.slice(0, start).join(""), count: start });
	}

	const midOld = oldTokens.slice(start, oldEnd + 1);
	const midNew = newTokens.slice(start, newEnd + 1);
	const m = midOld.length;
	const n = midNew.length;

	if (m === 0 && n > 0) {
		rawParts.push({ value: midNew.join(""), added: true, count: n });
	} else if (n === 0 && m > 0) {
		rawParts.push({ value: midOld.join(""), removed: true, count: m });
	} else if (m > 0 && n > 0) {
		// Guard against quadratic blowup on very large middle sections
		if (m * n > 2_500_000) {
			rawParts.push({ value: midOld.join(""), removed: true, count: m });
			rawParts.push({ value: midNew.join(""), added: true, count: n });
		} else {
			const dp = new Uint32Array((m + 1) * (n + 1));
			const stride = n + 1;
			for (let i = m - 1; i >= 0; i--) {
				for (let j = n - 1; j >= 0; j--) {
					if (midOld[i] === midNew[j]) {
						dp[i * stride + j] = dp[(i + 1) * stride + (j + 1)] + 1;
					} else {
						const down = dp[(i + 1) * stride + j];
						const right = dp[i * stride + (j + 1)];
						dp[i * stride + j] = down >= right ? down : right;
					}
				}
			}

			let i = 0;
			let j = 0;
			while (i < m && j < n) {
				if (midOld[i] === midNew[j]) {
					rawParts.push({ value: midOld[i], count: 1 });
					i++;
					j++;
				} else if (dp[(i + 1) * stride + j] >= dp[i * stride + (j + 1)]) {
					rawParts.push({ value: midOld[i], removed: true, count: 1 });
					i++;
				} else {
					rawParts.push({ value: midNew[j], added: true, count: 1 });
					j++;
				}
			}
			while (i < m) {
				rawParts.push({ value: midOld[i], removed: true, count: 1 });
				i++;
			}
			while (j < n) {
				rawParts.push({ value: midNew[j], added: true, count: 1 });
				j++;
			}
		}
	}

	if (oldEnd + 1 < oldLen) {
		const tail = oldTokens.slice(oldEnd + 1);
		rawParts.push({ value: tail.join(""), count: tail.length });
	}

	// Coalesce adjacent parts of identical kind
	const merged: DiffPart[] = [];
	for (const part of rawParts) {
		const prev = merged[merged.length - 1];
		if (prev && Boolean(prev.added) === Boolean(part.added) && Boolean(prev.removed) === Boolean(part.removed)) {
			prev.value += part.value;
			prev.count = (prev.count ?? 0) + (part.count ?? 0);
		} else {
			merged.push({ ...part });
		}
	}
	return merged;
}

function splitLinesPreservingEndings(text: string): string[] {
	if (text.length === 0) return [];
	const tokens: string[] = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") {
			tokens.push(text.slice(start, i + 1));
			start = i + 1;
		}
	}
	if (start < text.length) {
		tokens.push(text.slice(start));
	}
	return tokens;
}

function tokenizeWords(text: string): string[] {
	if (text.length === 0) return [];
	return text.match(/\s+|\w+|[^\s\w]+/g) ?? [text];
}

function loadDiffEngine(): DiffEngine {
	try {
		const pkgRequire = createRequire(path.join(getPackageDir(), "package.json"));
		const diffMod = pkgRequire("diff") as Partial<DiffEngine>;
		if (typeof diffMod.diffLines === "function" && typeof diffMod.diffWords === "function") {
			return {
				diffLines: (oldText: string, newText: string) => diffMod.diffLines!(oldText, newText),
				diffWords: (oldText: string, newText: string) => diffMod.diffWords!(oldText, newText),
			};
		}
	} catch {
		// Fall through to built-in LCS diff engine when running without external node_modules
	}
	return {
		diffLines: (oldText: string, newText: string) =>
			computeLcsDiffParts(splitLinesPreservingEndings(oldText), splitLinesPreservingEndings(newText)),
		diffWords: (oldText: string, newText: string) =>
			computeLcsDiffParts(tokenizeWords(oldText), tokenizeWords(newText)),
	};
}

const Diff = loadDiffEngine();

// ============================================================================
// Step 2: Canonical Path Normalization & Safe Disk Snapshot Reader
// ============================================================================

const UNICODE_SPACES_PATTERN = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeWindowsShellPath(filePath: string): string {
	if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) {
		return filePath;
	}
	const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!match) {
		return filePath;
	}
	const suffix = match[2]?.replaceAll("/", "\\") ?? "";
	return `${match[1].toUpperCase()}:\\${suffix}`;
}

function cleanUserFilePath(rawPath: string): string {
	let cleaned = rawPath.trim().replace(UNICODE_SPACES_PATTERN, " ");
	if (cleaned.startsWith("@")) {
		cleaned = cleaned.slice(1);
	}
	if (process.platform === "win32") {
		cleaned = normalizeWindowsShellPath(cleaned);
	}
	const home = homedir();
	if (cleaned === "~") {
		return home;
	}
	if (cleaned.startsWith("~/") || (process.platform === "win32" && cleaned.startsWith("~\\"))) {
		return path.join(home, cleaned.slice(2));
	}
	return cleaned;
}

/**
 * Resolves a path to its canonical realpath, walking up to the nearest existing ancestor
 * directory when the target path or intermediate directories do not exist yet.
 */
function canonicalizePathWithAncestors(resolvedPath: string): string {
	try {
		return realpathSync(resolvedPath);
	} catch {
		const parent = path.dirname(resolvedPath);
		if (parent === resolvedPath) {
			return resolvedPath;
		}
		const base = path.basename(resolvedPath);
		return path.join(canonicalizePathWithAncestors(parent), base);
	}
}

export function getPathLookupKey(relOrAbsPath: string): string {
	const forwardSlashes = relOrAbsPath.replaceAll("\\", "/");
	return process.platform === "win32" ? forwardSlashes.toLowerCase() : forwardSlashes;
}

export function isSwarmBlackboardPath(relOrAbsPath: string): boolean {
	return /(?:^|[\\/])\.swarm(?:[\\/]|$)/i.test(relOrAbsPath);
}

export function isSubagentChildProcess(ctx?: ExtensionContext): boolean {
	if (process.env.PI_SUBAGENT_DEPTH !== undefined && process.env.PI_SUBAGENT_DEPTH !== "") {
		return true;
	}
	if (ctx?.mode === "rpc") {
		return true;
	}
	return false;
}

export function normalizeSessionFilePath(
	rawPath: string,
	cwd: string,
): { absPath: string; relPath: string } {
	const cleaned = cleanUserFilePath(rawPath);
	const canonicalCwd = canonicalizePathWithAncestors(path.resolve(cleanUserFilePath(cwd)));
	const candidateAbs = path.isAbsolute(cleaned)
		? path.resolve(cleaned)
		: path.resolve(canonicalCwd, cleaned);
	const absPath = canonicalizePathWithAncestors(candidateAbs);

	const compareCwd = process.platform === "win32" ? canonicalCwd.toLowerCase() : canonicalCwd;
	const compareAbs = process.platform === "win32" ? absPath.toLowerCase() : absPath;

	const cwdPrefix = compareCwd.endsWith(path.sep) ? compareCwd : `${compareCwd}${path.sep}`;
	if (compareAbs === compareCwd) {
		return { absPath, relPath: "." };
	}
	if (compareAbs.startsWith(cwdPrefix)) {
		const rel = absPath.slice(cwdPrefix.length).split(path.sep).join("/");
		return { absPath, relPath: rel };
	}

	const relativePath = path.relative(canonicalCwd, absPath);
	const isInsideCwd =
		relativePath !== "" &&
		relativePath !== ".." &&
		!relativePath.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relativePath);
	if (isInsideCwd) {
		return { absPath, relPath: relativePath.split(path.sep).join("/") };
	}

	return { absPath, relPath: absPath.split(path.sep).join("/") };
}

export async function readFileSnapshot(absPath: string): Promise<FileSnapshotProbe> {
	let stats;
	try {
		stats = await stat(absPath);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return { exists: false, content: null, isBinary: false, tooLarge: false, byteLength: 0 };
		}
		return { exists: false, content: null, isBinary: false, tooLarge: false, byteLength: 0 };
	}

	if (!stats.isFile()) {
		return { exists: false, content: null, isBinary: false, tooLarge: false, byteLength: 0 };
	}

	if (stats.size > MAX_SNAPSHOT_BYTES) {
		return {
			exists: true,
			content: null,
			isBinary: false,
			tooLarge: true,
			byteLength: stats.size,
		};
	}

	try {
		const buf = await readFile(absPath);
		const probeLen = Math.min(buf.length, BINARY_PROBE_BYTES);
		if (buf.subarray(0, probeLen).includes(0)) {
			return {
				exists: true,
				content: null,
				isBinary: true,
				tooLarge: false,
				byteLength: buf.length,
			};
		}

		let decoded = buf.toString("utf-8");
		if (decoded.charCodeAt(0) === 0xfeff) {
			decoded = decoded.slice(1);
		}
		const normalizedContent = decoded.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		return {
			exists: true,
			content: normalizedContent,
			isBinary: false,
			tooLarge: false,
			byteLength: buf.length,
		};
	} catch {
		return { exists: false, content: null, isBinary: false, tooLarge: false, byteLength: 0 };
	}
}

function getFileRevisionKey(absPath: string, state: TrackedFileState): string {
	try {
		const st = statSync(absPath);
		return `${st.size}:${st.mtimeMs}:${state.editCount}:${state.lastModifiedAt}`;
	} catch {
		return `missing:${state.editCount}:${state.lastModifiedAt}`;
	}
}

// ============================================================================
// Step 4: Diff Computation Engine, Paired Alignment & Word-Diff Highlighting
// ============================================================================

export function sanitizeSourceLine(line: string): string {
	return replaceControlCharacters(line.replace(/\t/g, TAB_REPLACEMENT));
}

function splitDiffPartIntoLines(value: string): string[] {
	if (value.length === 0) return [];
	const trimmed = value.endsWith("\n") ? value.slice(0, -1) : value;
	return trimmed.split("\n").map(sanitizeSourceLine);
}

/**
 * Computes intra-line word diff segments between a paired old and new line.
 * Strips leading indentation whitespace from the first changed token so indentation
 * is not inverse-highlighted (matching Pi's built-in diff renderer).
 */
export function computeWordDiffSegments(
	oldLine: string,
	newLine: string,
): { oldSegments: WordSegment[]; newSegments: WordSegment[] } {
	const wordParts = Diff.diffWords(oldLine, newLine);
	const oldSegments: WordSegment[] = [];
	const newSegments: WordSegment[] = [];
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordParts) {
		if (part.removed) {
			let value = part.value;
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] ?? "";
				if (leadingWs.length > 0) {
					oldSegments.push({ text: leadingWs, highlight: false });
					value = value.slice(leadingWs.length);
				}
				isFirstRemoved = false;
			}
			if (value.length > 0) {
				oldSegments.push({ text: value, highlight: true });
			}
		} else if (part.added) {
			let value = part.value;
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] ?? "";
				if (leadingWs.length > 0) {
					newSegments.push({ text: leadingWs, highlight: false });
					value = value.slice(leadingWs.length);
				}
				isFirstAdded = false;
			}
			if (value.length > 0) {
				newSegments.push({ text: value, highlight: true });
			}
		} else {
			if (part.value.length > 0) {
				oldSegments.push({ text: part.value, highlight: false });
				newSegments.push({ text: part.value, highlight: false });
			}
		}
	}

	return { oldSegments, newSegments };
}

function extractDiffHunks(alignedRows: AlignedDiffRow[]): DiffHunkRange[] {
	const totalRows = alignedRows.length;
	if (totalRows === 0) return [];

	// Locate contiguous change blocks
	const changeBlocks: Array<{ start: number; end: number }> = [];
	let idx = 0;
	while (idx < totalRows) {
		if (alignedRows[idx].isChanged) {
			const start = idx;
			while (idx + 1 < totalRows && alignedRows[idx + 1].isChanged) {
				idx++;
			}
			changeBlocks.push({ start, end: idx });
		}
		idx++;
	}

	if (changeBlocks.length === 0) {
		return [];
	}

	// Expand by CONTEXT_LINES before/after and merge blocks separated by <= 2 * CONTEXT_LINES (6) unchanged lines
	const mergedRanges: Array<{
		startRowIndex: number;
		endRowIndex: number;
		firstChangedRowIndex: number;
	}> = [];

	for (const block of changeBlocks) {
		const expandedStart = Math.max(0, block.start - CONTEXT_LINES);
		const expandedEnd = Math.min(totalRows - 1, block.end + CONTEXT_LINES);
		const prev = mergedRanges[mergedRanges.length - 1];
		if (prev && expandedStart <= prev.endRowIndex + 1) {
			prev.endRowIndex = Math.max(prev.endRowIndex, expandedEnd);
		} else {
			mergedRanges.push({
				startRowIndex: expandedStart,
				endRowIndex: expandedEnd,
				firstChangedRowIndex: block.start,
			});
		}
	}

	return mergedRanges.map((range) => {
		let oldCount = 0;
		let newCount = 0;
		let oldStart: number | null = null;
		let newStart: number | null = null;

		for (let r = range.startRowIndex; r <= range.endRowIndex; r++) {
			const row = alignedRows[r];
			if (row.left.lineNo !== null) {
				if (oldStart === null) oldStart = row.left.lineNo;
				oldCount++;
			}
			if (row.right.lineNo !== null) {
				if (newStart === null) newStart = row.right.lineNo;
				newCount++;
			}
		}

		// Find nearest preceding line numbers when a hunk is purely additions or purely deletions
		if (oldStart === null) {
			for (let r = range.startRowIndex - 1; r >= 0; r--) {
				if (alignedRows[r].left.lineNo !== null) {
					oldStart = alignedRows[r].left.lineNo;
					break;
				}
			}
			oldStart = oldStart ?? 0;
		}
		if (newStart === null) {
			for (let r = range.startRowIndex - 1; r >= 0; r--) {
				if (alignedRows[r].right.lineNo !== null) {
					newStart = alignedRows[r].right.lineNo;
					break;
				}
			}
			newStart = newStart ?? 0;
		}

		const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
		return {
			header,
			startRowIndex: range.startRowIndex,
			endRowIndex: range.endRowIndex,
			firstChangedRowIndex: range.firstChangedRowIndex,
			oldStart,
			oldCount,
			newStart,
			newCount,
		};
	});
}

export async function computeFileDiff(
	state: TrackedFileState,
	cwd: string,
): Promise<ComputedFileDiff> {
	const { absPath } = normalizeSessionFilePath(state.relPath, cwd);
	const current = await readFileSnapshot(absPath);
	const revisionKey = getFileRevisionKey(absPath, state);

	let status: FileStatus;
	if (state.isBinary || current.isBinary) {
		status = "binary";
	} else if (state.tooLarge || current.tooLarge) {
		status = "too-large";
	} else if (
		(!state.existedBefore && !current.exists) ||
		(state.existedBefore && current.exists && state.oldContent === current.content)
	) {
		status = "reverted";
	} else if (!state.existedBefore && current.exists) {
		status = "added";
	} else if (state.existedBefore && !current.exists) {
		status = "deleted";
	} else {
		status = "modified";
	}

	if (status === "binary" || status === "too-large") {
		return {
			relPath: state.relPath,
			absPath,
			status,
			addedLines: 0,
			removedLines: 0,
			maxLineNumber: 1,
			oldByteLength: state.byteLength,
			newByteLength: current.byteLength,
			editCount: state.editCount,
			lastTool: state.lastTool,
			lastModifiedAt: state.lastModifiedAt,
			revisionKey,
			alignedRows: [],
			hunks: [],
		};
	}

	const oldText = state.existedBefore ? (state.oldContent ?? "") : "";
	const newText = current.exists ? (current.content ?? "") : "";

	const parts = Diff.diffLines(oldText, newText);
	const alignedRows: AlignedDiffRow[] = [];
	let oldLineNum = 1;
	let newLineNum = 1;
	let addedLinesCount = 0;
	let removedLinesCount = 0;

	let partIndex = 0;
	while (partIndex < parts.length) {
		const part = parts[partIndex];
		if (!part.added && !part.removed) {
			const contextLines = splitDiffPartIntoLines(part.value);
			for (const lineText of contextLines) {
				const oldNo = oldLineNum++;
				const newNo = newLineNum++;
				alignedRows.push({
					left: { type: "context", lineNo: oldNo, rawText: lineText },
					right: { type: "context", lineNo: newNo, rawText: lineText },
					isChanged: false,
				});
			}
			partIndex++;
			continue;
		}

		// Collect consecutive removed and added parts into a paired change block
		const removedLines: string[] = [];
		const addedLines: string[] = [];
		while (partIndex < parts.length && (parts[partIndex].removed || parts[partIndex].added)) {
			const changePart = parts[partIndex];
			const lines = splitDiffPartIntoLines(changePart.value);
			if (changePart.removed) {
				removedLines.push(...lines);
			} else if (changePart.added) {
				addedLines.push(...lines);
			}
			partIndex++;
		}

		removedLinesCount += removedLines.length;
		addedLinesCount += addedLines.length;

		const maxBlockLen = Math.max(removedLines.length, addedLines.length);
		for (let i = 0; i < maxBlockLen; i++) {
			const oldLine = removedLines[i];
			const newLine = addedLines[i];

			if (oldLine !== undefined && newLine !== undefined) {
				const { oldSegments, newSegments } = computeWordDiffSegments(oldLine, newLine);
				alignedRows.push({
					left: {
						type: "removed",
						lineNo: oldLineNum++,
						rawText: oldLine,
						wordSegments: oldSegments,
					},
					right: {
						type: "added",
						lineNo: newLineNum++,
						rawText: newLine,
						wordSegments: newSegments,
					},
					isChanged: true,
				});
			} else if (oldLine !== undefined) {
				alignedRows.push({
					left: { type: "removed", lineNo: oldLineNum++, rawText: oldLine },
					right: { type: "filler", lineNo: null, rawText: "" },
					isChanged: true,
				});
			} else if (newLine !== undefined) {
				alignedRows.push({
					left: { type: "filler", lineNo: null, rawText: "" },
					right: { type: "added", lineNo: newLineNum++, rawText: newLine },
					isChanged: true,
				});
			}
		}
	}

	const maxLineNumber = Math.max(1, oldLineNum - 1, newLineNum - 1);
	const hunks = extractDiffHunks(alignedRows);

	return {
		relPath: state.relPath,
		absPath,
		status,
		addedLines: addedLinesCount,
		removedLines: removedLinesCount,
		maxLineNumber,
		oldByteLength: state.byteLength,
		newByteLength: current.byteLength,
		editCount: state.editCount,
		lastTool: state.lastTool,
		lastModifiedAt: state.lastModifiedAt,
		revisionKey,
		alignedRows,
		hunks,
	};
}

// ============================================================================
// Step 5: Responsive Split-Pane & Unified TUI Overlay Component
// ============================================================================

function padVisibleRight(text: string, targetWidth: number): string {
	if (targetWidth <= 0) return "";
	const w = visibleWidth(text);
	if (w > targetWidth) {
		return truncateToWidth(text, targetWidth, "…", true);
	}
	if (w < targetWidth) {
		return text + " ".repeat(targetWidth - w);
	}
	return text;
}

function formatByteSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(1)} KB`;
	return `${(kb / 1024).toFixed(2)} MB`;
}

function formatStatusBadge(status: FileStatus, theme: Theme): string {
	switch (status) {
		case "modified":
			return theme.fg("warning", "[MODIFIED]");
		case "added":
			return theme.fg("success", "[NEW FILE]");
		case "deleted":
			return theme.fg("error", "[DELETED]");
		case "reverted":
			return theme.fg("muted", "[REVERTED]");
		case "binary":
			return theme.fg("warning", "[BINARY]");
		case "too-large":
			return theme.fg("warning", "[>512KB]");
	}
}

function styleCellCode(cell: DiffCell, theme: Theme): string {
	if (cell.type === "context") {
		return theme.fg("toolDiffContext", cell.rawText);
	}
	if (cell.type === "removed") {
		if (cell.wordSegments && cell.wordSegments.length > 0) {
			const inner = cell.wordSegments
				.map((seg) => (seg.highlight ? theme.inverse(seg.text) : seg.text))
				.join("");
			return theme.fg("toolDiffRemoved", inner);
		}
		return theme.fg("toolDiffRemoved", cell.rawText);
	}
	if (cell.type === "added") {
		if (cell.wordSegments && cell.wordSegments.length > 0) {
			const inner = cell.wordSegments
				.map((seg) => (seg.highlight ? theme.inverse(seg.text) : seg.text))
				.join("");
			return theme.fg("toolDiffAdded", inner);
		}
		return theme.fg("toolDiffAdded", cell.rawText);
	}
	return "";
}

function wrapCellCode(cell: DiffCell, codeWidth: number, theme: Theme): string[] {
	if (codeWidth <= 0) return [""];
	if (cell.type === "filler") return [];
	if (cell.rawText.length === 0) return [""];
	const styled = styleCellCode(cell, theme);
	const wrapped = wrapTextWithAnsi(styled, codeWidth);
	return wrapped.length > 0 ? wrapped : [""];
}

export class SessionDiffOverlay implements Component, Focusable {
	public focused = false;
	public capturesViewportInput = true;

	private currentFileIndex = 0;
	private scrollOffset = 0;
	private viewMode: ViewMode = "hunks";
	private layoutMode: LayoutMode = "split";
	private pickerOpen = false;
	private pickerIndex = 0;
	private renderCache = new Map<string, CachedRenderBody>();
	private isRefreshing = false;
	private closed = false;
	private mountedAt = Date.now();
	private hasRenderedOnce = false;
	private lastShortcutInputAt = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly cwd: string,
		private readonly getTrackedStates: () => TrackedFileState[],
		private diffs: ComputedFileDiff[],
		initialFileIndex: number,
		private readonly onClose: () => void,
		private readonly onRefresh?: () => Promise<TrackedFileState[]>,
		private readonly onShortcutInput?: () => void,
		private readonly onFirstRender?: () => void,
		private readonly onDispose?: () => void,
	) {
		this.currentFileIndex = Math.max(0, Math.min(initialFileIndex, Math.max(0, diffs.length - 1)));
		this.pickerIndex = this.currentFileIndex;
	}

	public markMounted(): void {
		const now = Date.now();
		this.mountedAt = now;
		this.lastShortcutInputAt = now;
	}

	public isWithinOpenGuard(
		guardMs = OVERLAY_OPEN_CLOSE_GUARD_MS,
		now = Date.now(),
	): boolean {
		return !this.hasRenderedOnce || now - this.mountedAt < guardMs;
	}

	public invalidate(): void {
		this.renderCache.clear();
	}

	public dispose(): void {
		this.renderCache.clear();
		this.closed = true;
		this.onDispose?.();
	}

	public close(): void {
		if (this.closed) return;
		this.closed = true;
		this.onDispose?.();
		this.onClose();
	}

	private getEffectiveLayoutMode(width: number): LayoutMode {
		if (width < MIN_SIDE_BY_SIDE_WIDTH) {
			return "unified";
		}
		return this.layoutMode;
	}

	private getViewportHeight(
		effectiveLayout: LayoutMode = this.getEffectiveLayoutMode(this.tui.terminal?.columns ?? 100),
	): number {
		const termRows = this.tui.terminal?.rows ?? 32;
		// Chrome rows: top border (1) + header (1) + subheader/divider (1-2) + footer sep (1) + footer (1) + bottom border (1)
		const chromeLines = effectiveLayout === "split" && !this.pickerOpen ? 7 : 6;
		return Math.max(8, Math.floor(termRows * 0.88) - chromeLines);
	}

	private scrollBy(delta: number): void {
		this.scrollOffset = Math.max(0, this.scrollOffset + delta);
		this.tui.requestRender();
	}

	private movePickerBy(delta: number, wrap = false): void {
		if (this.diffs.length === 0) return;
		if (wrap) {
			this.pickerIndex =
				(((this.pickerIndex + delta) % this.diffs.length) + this.diffs.length) %
				this.diffs.length;
		} else {
			this.pickerIndex = Math.max(
				0,
				Math.min(this.diffs.length - 1, this.pickerIndex + delta),
			);
		}

		const viewportHeight = this.getViewportHeight();
		const selectedLineIdx = this.pickerIndex + 2;
		if (this.pickerIndex === 0 && this.scrollOffset > 0 && selectedLineIdx <= this.scrollOffset + 2) {
			this.scrollOffset = 0;
		} else if (selectedLineIdx < this.scrollOffset) {
			this.scrollOffset = selectedLineIdx;
		} else if (selectedLineIdx >= this.scrollOffset + viewportHeight) {
			this.scrollOffset = selectedLineIdx - viewportHeight + 1;
		}

		this.tui.requestRender();
	}

	public handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed) {
			return { handled: true, render: false };
		}

		if (event.type === "wheel") {
			const rawDelta = event.wheelDelta ?? 0;
			if (rawDelta === 0) {
				return { handled: true, render: false };
			}
			if (this.pickerOpen) {
				this.movePickerBy(rawDelta > 0 ? 1 : -1, false);
				return { handled: true };
			}
			const scrollDelta =
				Math.abs(rawDelta) > 1
					? rawDelta
					: Math.sign(rawDelta) * MOUSE_WHEEL_SCROLL_LINES;
			this.scrollBy(scrollDelta);
			return { handled: true };
		}

		return { handled: true, render: false };
	}

	private getActiveDiff(): ComputedFileDiff | undefined {
		if (this.diffs.length === 0) return undefined;
		if (this.currentFileIndex >= this.diffs.length) {
			this.currentFileIndex = this.diffs.length - 1;
		}
		return this.diffs[this.currentFileIndex];
	}

	private getCachedBody(
		diff: ComputedFileDiff,
		innerWidth: number,
		effectiveLayout: LayoutMode,
	): CachedRenderBody {
		const cacheKey = `${diff.relPath}:${this.viewMode}:${effectiveLayout}:${innerWidth}:${diff.revisionKey}`;
		const existing = this.renderCache.get(cacheKey);
		if (existing) {
			return existing;
		}

		const built = this.buildDiffBody(diff, innerWidth, effectiveLayout);
		this.renderCache.set(cacheKey, built);
		return built;
	}

	private buildStatusNoticeLines(diff: ComputedFileDiff, innerWidth: number): CachedRenderBody {
		const lines: string[] = [];
		const pushCentered = (text: string) => {
			const w = visibleWidth(text);
			const leftPad = Math.max(0, Math.floor((innerWidth - w) / 2));
			lines.push(padVisibleRight(" ".repeat(leftPad) + text, innerWidth));
		};

		lines.push(padVisibleRight("", innerWidth));
		if (diff.status === "binary") {
			pushCentered(this.theme.fg("warning", "Binary file changed — textual diff not shown."));
			pushCentered(
				this.theme.fg(
					"muted",
					`Baseline size: ${formatByteSize(diff.oldByteLength)} → Current size: ${formatByteSize(diff.newByteLength)}`,
				),
			);
		} else if (diff.status === "too-large") {
			pushCentered(
				this.theme.fg(
					"warning",
					`File exceeds ${formatByteSize(MAX_SNAPSHOT_BYTES)} snapshot limit — diff omitted for performance.`,
				),
			);
			pushCentered(
				this.theme.fg(
					"muted",
					`Baseline size: ${formatByteSize(diff.oldByteLength)} → Current size: ${formatByteSize(diff.newByteLength)}`,
				),
			);
		} else if (diff.status === "reverted") {
			pushCentered(
				this.theme.fg("muted", "Working tree matches session baseline (changes were reverted)."),
			);
			if (diff.alignedRows.length > 0) {
				pushCentered(this.theme.fg("dim", "Press 'f' to view full file contents."));
			}
		} else if (diff.alignedRows.length === 0) {
			pushCentered(this.theme.fg("muted", "(Empty file)"));
		}
		lines.push(padVisibleRight("", innerWidth));

		return { lines, hunkLineOffsets: [] };
	}

	private renderSplitPaneSubLine(
		cell: DiffCell,
		subIndex: number,
		wrappedLines: string[],
		gutterWidth: number,
		codeWidth: number,
	): string {
		const sep = this.theme.fg("borderMuted", "│");
		if (cell.type === "filler" || subIndex >= wrappedLines.length) {
			const blankGutter = " ".repeat(gutterWidth);
			const fillerBar = this.theme.fg("dim", "░".repeat(Math.max(0, codeWidth)));
			return `${blankGutter}${sep}  ${ padVisibleRight(fillerBar, codeWidth) }`;
		}

		const gutterText =
			subIndex === 0 && cell.lineNo !== null
				? this.theme.fg("dim", String(cell.lineNo).padStart(gutterWidth, " "))
				: this.theme.fg("dim", "·".padStart(gutterWidth, " "));

		let signChar = " ";
		if (subIndex === 0) {
			if (cell.type === "removed") {
				signChar = this.theme.fg("toolDiffRemoved", "-");
			} else if (cell.type === "added") {
				signChar = this.theme.fg("toolDiffAdded", "+");
			}
		}

		const codeSegment = padVisibleRight(wrappedLines[subIndex] ?? "", codeWidth);
		return `${gutterText}${sep}${signChar} ${codeSegment}`;
	}

	private renderSplitAlignedRow(
		row: AlignedDiffRow,
		leftW: number,
		rightW: number,
		gutterW: number,
	): string[] {
		const leftCodeW = Math.max(1, leftW - gutterW - 3);
		const rightCodeW = Math.max(1, rightW - gutterW - 3);

		const leftWrapped = wrapCellCode(row.left, leftCodeW, this.theme);
		const rightWrapped = wrapCellCode(row.right, rightCodeW, this.theme);
		const subCount = Math.max(1, leftWrapped.length, rightWrapped.length);
		const centerDivider = this.theme.fg("borderMuted", "│");

		const out: string[] = [];
		for (let s = 0; s < subCount; s++) {
			const leftCellStr = padVisibleRight(
				this.renderSplitPaneSubLine(row.left, s, leftWrapped, gutterW, leftCodeW),
				leftW,
			);
			const rightCellStr = padVisibleRight(
				this.renderSplitPaneSubLine(row.right, s, rightWrapped, gutterW, rightCodeW),
				rightW,
			);
			out.push(`${leftCellStr}${centerDivider}${rightCellStr}`);
		}
		return out;
	}

	private renderUnifiedCellRows(
		cell: DiffCell,
		oldLineNo: number | null,
		newLineNo: number | null,
		innerWidth: number,
		gutterW: number,
	): string[] {
		const gutterTotal = 2 * gutterW + 4; // oldLn + " " + newLn + "│" + sign + " "
		const codeW = Math.max(1, innerWidth - gutterTotal);
		const wrapped = wrapCellCode(cell, codeW, this.theme);
		const sep = this.theme.fg("borderMuted", "│");
		const out: string[] = [];

		for (let s = 0; s < wrapped.length; s++) {
			let oldGutter: string;
			let newGutter: string;
			if (s === 0) {
				oldGutter =
					oldLineNo !== null
						? this.theme.fg("dim", String(oldLineNo).padStart(gutterW, " "))
						: " ".repeat(gutterW);
				newGutter =
					newLineNo !== null
						? this.theme.fg("dim", String(newLineNo).padStart(gutterW, " "))
						: " ".repeat(gutterW);
			} else {
				oldGutter =
					oldLineNo !== null
						? this.theme.fg("dim", "·".padStart(gutterW, " "))
						: " ".repeat(gutterW);
				newGutter =
					newLineNo !== null
						? this.theme.fg("dim", "·".padStart(gutterW, " "))
						: " ".repeat(gutterW);
			}

			let sign = " ";
			if (s === 0) {
				if (cell.type === "removed") {
					sign = this.theme.fg("toolDiffRemoved", "-");
				} else if (cell.type === "added") {
					sign = this.theme.fg("toolDiffAdded", "+");
				}
			}

			const codePart = padVisibleRight(wrapped[s] ?? "", codeW);
			out.push(padVisibleRight(`${oldGutter} ${newGutter}${sep}${sign} ${codePart}`, innerWidth));
		}
		return out;
	}

	private renderRangeOfRows(
		alignedRows: AlignedDiffRow[],
		startIdx: number,
		endIdx: number,
		innerWidth: number,
		effectiveLayout: LayoutMode,
		gutterW: number,
		outLines: string[],
		rowOffsetMap?: Map<number, number>,
	): void {
		if (effectiveLayout === "split") {
			const leftW = Math.floor((innerWidth - 1) / 2);
			const rightW = innerWidth - 1 - leftW;
			for (let r = startIdx; r <= endIdx; r++) {
				rowOffsetMap?.set(r, outLines.length);
				const rendered = this.renderSplitAlignedRow(alignedRows[r], leftW, rightW, gutterW);
				for (const line of rendered) {
					outLines.push(padVisibleRight(line, innerWidth));
				}
			}
			return;
		}

		// Unified mode: group consecutive changed rows so removed lines appear before added lines per block
		let r = startIdx;
		while (r <= endIdx) {
			const row = alignedRows[r];
			if (!row.isChanged) {
				rowOffsetMap?.set(r, outLines.length);
				const unifiedLines = this.renderUnifiedCellRows(
					row.left,
					row.left.lineNo,
					row.right.lineNo,
					innerWidth,
					gutterW,
				);
				outLines.push(...unifiedLines);
				r++;
				continue;
			}

			const blockStart = r;
			const removedCells: DiffCell[] = [];
			const addedCells: DiffCell[] = [];
			while (r <= endIdx && alignedRows[r].isChanged) {
				rowOffsetMap?.set(r, outLines.length);
				const changedRow = alignedRows[r];
				if (changedRow.left.type === "removed") {
					removedCells.push(changedRow.left);
				}
				if (changedRow.right.type === "added") {
					addedCells.push(changedRow.right);
				}
				r++;
			}
			rowOffsetMap?.set(blockStart, outLines.length);

			for (const rem of removedCells) {
				outLines.push(
					...this.renderUnifiedCellRows(rem, rem.lineNo, null, innerWidth, gutterW),
				);
			}
			for (const add of addedCells) {
				outLines.push(
					...this.renderUnifiedCellRows(add, null, add.lineNo, innerWidth, gutterW),
				);
			}
		}
	}

	private buildDiffBody(
		diff: ComputedFileDiff,
		innerWidth: number,
		effectiveLayout: LayoutMode,
	): CachedRenderBody {
		if (
			diff.status === "binary" ||
			diff.status === "too-large" ||
			(diff.status === "reverted" && this.viewMode === "hunks") ||
			diff.alignedRows.length === 0
		) {
			return this.buildStatusNoticeLines(diff, innerWidth);
		}

		const gutterW = Math.max(3, String(diff.maxLineNumber).length);
		const lines: string[] = [];
		const hunkLineOffsets: number[] = [];

		if (this.viewMode === "hunks") {
			if (diff.hunks.length === 0) {
				return this.buildStatusNoticeLines(diff, innerWidth);
			}
			for (let hIdx = 0; hIdx < diff.hunks.length; hIdx++) {
				const hunk = diff.hunks[hIdx];
				hunkLineOffsets.push(lines.length);
				const hunkLabel = ` ${hunk.header} (${hIdx + 1}/${diff.hunks.length}) `;
				const fillLen = Math.max(0, innerWidth - visibleWidth(hunkLabel));
				const hunkHeaderLine =
					this.theme.fg("accent", hunkLabel) + this.theme.fg("borderMuted", "─".repeat(fillLen));
				lines.push(padVisibleRight(hunkHeaderLine, innerWidth));

				this.renderRangeOfRows(
					diff.alignedRows,
					hunk.startRowIndex,
					hunk.endRowIndex,
					innerWidth,
					effectiveLayout,
					gutterW,
					lines,
				);
			}
		} else {
			// Full file mode: render all rows 0..N-1 and record hunk offsets at each change block start
			const rowOffsetMap = new Map<number, number>();
			this.renderRangeOfRows(
				diff.alignedRows,
				0,
				diff.alignedRows.length - 1,
				innerWidth,
				effectiveLayout,
				gutterW,
				lines,
				rowOffsetMap,
			);
			for (const hunk of diff.hunks) {
				const offset = rowOffsetMap.get(hunk.firstChangedRowIndex) ?? rowOffsetMap.get(hunk.startRowIndex) ?? 0;
				hunkLineOffsets.push(offset);
			}
		}

		return { lines, hunkLineOffsets };
	}

	private buildPickerBody(innerWidth: number): string[] {
		const lines: string[] = [];
		const title = ` Select Modified File (${this.diffs.length} tracked in session branch) `;
		lines.push(
			padVisibleRight(
				this.theme.fg("accent", this.theme.bold(title)) +
					this.theme.fg("muted", "— ↑↓/jk move • Enter jump • Esc/p close"),
				innerWidth,
			),
		);
		lines.push(padVisibleRight(this.theme.fg("borderMuted", "─".repeat(innerWidth)), innerWidth));

		for (let i = 0; i < this.diffs.length; i++) {
			const d = this.diffs[i];
			const isSelected = i === this.pickerIndex;
			const isCurrent = i === this.currentFileIndex;
			const cursor = isSelected ? this.theme.fg("accent", "▸ ") : "  ";
			const currentMarker = isCurrent ? this.theme.fg("accent", "● ") : "  ";
			const statusTag = formatStatusBadge(d.status, this.theme);
			const statsText = `${this.theme.fg("success", `+${d.addedLines}`)} ${this.theme.fg("error", `-${d.removedLines}`)}`;
			const editsText = this.theme.fg("dim", `(${d.editCount}x ${d.lastTool})`);
			const rightMeta = `${statusTag} ${statsText} ${editsText} `;
			const rightMetaW = visibleWidth(rightMeta);
			const leftMaxW = Math.max(10, innerWidth - rightMetaW - 6);
			const fileLabel = truncateToWidth(
				isSelected ? this.theme.bold(this.theme.fg("accent", d.relPath)) : d.relPath,
				leftMaxW,
			);
			const leftPart = `${cursor}${currentMarker}${fileLabel}`;
			const gap = Math.max(1, innerWidth - visibleWidth(leftPart) - rightMetaW);
			const combined = `${leftPart}${" ".repeat(gap)}${rightMeta}`;
			const padded = padVisibleRight(combined, innerWidth);
			lines.push(isSelected ? this.theme.bg("selectedBg", padded) : padded);
		}
		return lines;
	}

	private getActiveHunkIndex(hunkOffsets: number[]): number {
		if (hunkOffsets.length === 0) return -1;
		let active = 0;
		for (let i = 0; i < hunkOffsets.length; i++) {
			if (hunkOffsets[i] <= this.scrollOffset + 2) {
				active = i;
			} else {
				break;
			}
		}
		return active;
	}

	public render(width: number): string[] {
		if (!this.hasRenderedOnce) {
			this.hasRenderedOnce = true;
			this.mountedAt = Date.now();
			this.onFirstRender?.();
		}
		const w = Math.max(20, width);
		const innerW = Math.max(1, w - 2);
		const effectiveLayout = this.getEffectiveLayoutMode(w);
		const viewportHeight = this.getViewportHeight(effectiveLayout);

		const leftBorder = this.theme.fg("border", "│");
		const rightBorder = this.theme.fg("border", "│");

		// 1. Top border
		const topTitle = " Session Diff ";
		const topDashTotal = Math.max(0, innerW - visibleWidth(topTitle));
		const topLeftDashes = Math.min(3, topDashTotal);
		const topRightDashes = Math.max(0, topDashTotal - topLeftDashes);
		const topLine =
			this.theme.fg("border", `╭${"─".repeat(topLeftDashes)}`) +
			this.theme.fg("accent", this.theme.bold(topTitle)) +
			this.theme.fg("border", `${"─".repeat(topRightDashes)}╮`);

		const activeDiff = this.getActiveDiff();
		if (!activeDiff) {
			const emptyLine = `${leftBorder}${padVisibleRight(this.theme.fg("muted", " No modified files in session branch."), innerW)}${rightBorder}`;
			const bottomLine = this.theme.fg("border", `╰${"─".repeat(innerW)}╯`);
			return [
				truncateToWidth(topLine, w, "", true),
				truncateToWidth(emptyLine, w, "", true),
				truncateToWidth(bottomLine, w, "", true),
			];
		}

		const cachedBody = this.getCachedBody(activeDiff, innerW, effectiveLayout);
		const bodySourceLines = this.pickerOpen
			? this.buildPickerBody(innerW)
			: cachedBody.lines;

		const totalBodyLines = bodySourceLines.length;
		const maxScroll = Math.max(0, totalBodyLines - viewportHeight);
		if (this.scrollOffset > maxScroll) {
			this.scrollOffset = maxScroll;
		}
		if (this.scrollOffset < 0) {
			this.scrollOffset = 0;
		}

		// 2. Header row
		const filePos = `[${this.currentFileIndex + 1}/${this.diffs.length}]`;
		const statusBadge = formatStatusBadge(activeDiff.status, this.theme);
		const statsStr = `${this.theme.fg("success", `+${activeDiff.addedLines}`)} ${this.theme.fg("error", `-${activeDiff.removedLines}`)}`;
		const editBadge = this.theme.fg("muted", `${activeDiff.editCount}x`);
		const layoutBadge = this.theme.fg(
			"muted",
			`[${effectiveLayout === "split" ? "Split" : "Unified"}]`,
		);
		const viewBadge = this.theme.fg("muted", `[${this.viewMode === "hunks" ? "Hunks" : "Full"}]`);
		const hunkOffsets = cachedBody.hunkLineOffsets;
		const activeHunkIdx = this.getActiveHunkIndex(hunkOffsets);
		const hunkBadge =
			hunkOffsets.length > 0
				? this.theme.fg("accent", `[Hunk ${activeHunkIdx + 1}/${hunkOffsets.length}]`)
				: this.theme.fg("dim", "[Hunk 0/0]");

		const rightBadges = ` ${statusBadge} ${statsStr} ${editBadge} ${layoutBadge} ${viewBadge} ${hunkBadge} `;
		const rightBadgesW = visibleWidth(rightBadges);
		const maxPathW = Math.max(8, innerW - rightBadgesW - visibleWidth(filePos) - 3);
		const truncatedPath = truncateToWidth(activeDiff.relPath, maxPathW);
		const leftHeader = ` ${this.theme.fg("muted", filePos)} ${this.theme.bold(this.theme.fg("accent", truncatedPath))}`;
		const headerGap = Math.max(1, innerW - visibleWidth(leftHeader) - rightBadgesW);
		const headerContent = padVisibleRight(
			`${leftHeader}${" ".repeat(headerGap)}${rightBadges}`,
			innerW,
		);
		const headerRow = `${leftBorder}${headerContent}${rightBorder}`;

		const outputLines: string[] = [
			truncateToWidth(topLine, w, "", true),
			truncateToWidth(headerRow, w, "", true),
		];

		// 3. Column title bar (in split mode when picker is closed) or divider
		if (!this.pickerOpen && effectiveLayout === "split") {
			const leftW = Math.floor((innerW - 1) / 2);
			const rightW = innerW - 1 - leftW;
			const leftTitle = padVisibleRight(
				` ${this.theme.fg("toolDiffRemoved", "LEFT: Baseline (Old)")}`,
				leftW,
			);
			const rightTitle = padVisibleRight(
				` ${this.theme.fg("toolDiffAdded", "RIGHT: Working Tree (New)")}`,
				rightW,
			);
			const colHeaderRow = `${leftBorder}${leftTitle}${this.theme.fg("borderMuted", "│")}${rightTitle}${rightBorder}`;
			const dividerRow = `${leftBorder}${this.theme.fg("borderMuted", `${"─".repeat(leftW)}┼${"─".repeat(rightW)}`)}${rightBorder}`;
			outputLines.push(truncateToWidth(colHeaderRow, w, "", true));
			outputLines.push(truncateToWidth(dividerRow, w, "", true));
		} else {
			const dividerRow = `${leftBorder}${this.theme.fg("borderMuted", "─".repeat(innerW))}${rightBorder}`;
			outputLines.push(truncateToWidth(dividerRow, w, "", true));
		}

		// 4. Viewport Body with Right-Edge Scrollbar
		const visibleSlice = bodySourceLines.slice(
			this.scrollOffset,
			this.scrollOffset + viewportHeight,
		);
		const rowCountToRender = Math.max(1, Math.min(viewportHeight, Math.max(8, visibleSlice.length)));

		const showScrollbar = totalBodyLines > rowCountToRender;
		const thumbHeight = showScrollbar
			? Math.max(1, Math.round((rowCountToRender / totalBodyLines) * rowCountToRender))
			: rowCountToRender;
		const maxThumbTop = Math.max(0, rowCountToRender - thumbHeight);
		const thumbTop =
			showScrollbar && maxScroll > 0
				? Math.round((this.scrollOffset / maxScroll) * maxThumbTop)
				: 0;

		for (let i = 0; i < rowCountToRender; i++) {
			const contentLine =
				i < visibleSlice.length
					? padVisibleRight(visibleSlice[i], innerW)
					: " ".repeat(innerW);
			let rightEdge = rightBorder;
			if (showScrollbar) {
				const isThumb = i >= thumbTop && i < thumbTop + thumbHeight;
				rightEdge = isThumb
					? this.theme.fg("scrollbarThumb", "█")
					: this.theme.fg("scrollbarTrack", "│");
			}
			outputLines.push(truncateToWidth(`${leftBorder}${contentLine}${rightEdge}`, w, "", true));
		}

		// 5. Footer separator & legend
		const scrollPct =
			maxScroll <= 0
				? "All"
				: this.scrollOffset <= 0
					? "Top"
					: this.scrollOffset >= maxScroll
						? "Bot"
						: `${Math.round((this.scrollOffset / maxScroll) * 100)}%`;

		const footerSep = `${leftBorder}${this.theme.fg("borderMuted", "─".repeat(innerW))}${rightBorder}`;
		outputLines.push(truncateToWidth(footerSep, w, "", true));

		const legendText =
			" ↑↓/jk scroll • PgUp/PgDn/C-u/C-d page • n/N hunk • [/]/Tab file • p files • f full/hunks • u split/unified • r refresh • q/Esc close";
		const rightScrollBadge = ` ${scrollPct} `;
		const maxLegendW = Math.max(10, innerW - visibleWidth(rightScrollBadge));
		const truncatedLegend = truncateToWidth(this.theme.fg("dim", legendText), maxLegendW);
		const legendGap = Math.max(
			0,
			innerW - visibleWidth(truncatedLegend) - visibleWidth(rightScrollBadge),
		);
		const footerContent = padVisibleRight(
			`${truncatedLegend}${" ".repeat(legendGap)}${this.theme.fg("muted", rightScrollBadge)}`,
			innerW,
		);
		outputLines.push(truncateToWidth(`${leftBorder}${footerContent}${rightBorder}`, w, "", true));

		// 6. Bottom border
		const bottomLine = this.theme.fg("border", `╰${"─".repeat(innerW)}╯`);
		outputLines.push(truncateToWidth(bottomLine, w, "", true));

		return outputLines;
	}

	private jumpToNextHunk(direction: 1 | -1): void {
		const activeDiff = this.getActiveDiff();
		if (!activeDiff) return;
		const termCols = this.tui.terminal?.columns ?? 100;
		const innerW = Math.max(1, termCols - 2);
		const effectiveLayout = this.getEffectiveLayoutMode(termCols);
		const { hunkLineOffsets } = this.getCachedBody(activeDiff, innerW, effectiveLayout);
		if (hunkLineOffsets.length === 0) return;

		if (direction === 1) {
			const nextOffset = hunkLineOffsets.find((offset) => offset > this.scrollOffset);
			this.scrollOffset = nextOffset !== undefined ? nextOffset : hunkLineOffsets[0];
		} else {
			let prevOffset: number | undefined;
			for (let i = hunkLineOffsets.length - 1; i >= 0; i--) {
				if (hunkLineOffsets[i] < this.scrollOffset) {
					prevOffset = hunkLineOffsets[i];
					break;
				}
			}
			this.scrollOffset =
				prevOffset !== undefined ? prevOffset : hunkLineOffsets[hunkLineOffsets.length - 1];
		}
	}

	private switchFile(delta: number): void {
		if (this.diffs.length <= 1) return;
		this.currentFileIndex =
			(this.currentFileIndex + delta + this.diffs.length) % this.diffs.length;
		this.pickerIndex = this.currentFileIndex;
		this.scrollOffset = 0;
	}

	private async refreshFromDisk(): Promise<void> {
		if (this.isRefreshing || this.closed) return;
		this.isRefreshing = true;
		try {
			const currentRelPath = this.getActiveDiff()?.relPath;
			const states = this.onRefresh ? await this.onRefresh() : this.getTrackedStates();
			const updated = await Promise.all(
				states.map((st) => computeFileDiff(st, this.cwd)),
			);
			this.diffs = updated;
			if (currentRelPath) {
				const foundIdx = updated.findIndex(
					(d) => getPathLookupKey(d.relPath) === getPathLookupKey(currentRelPath),
				);
				if (foundIdx >= 0) {
					this.currentFileIndex = foundIdx;
				}
			}
			this.renderCache.clear();
			this.tui.requestRender();
		} finally {
			this.isRefreshing = false;
		}
	}

	public handleInput(data: string): void {
		if (this.closed || isKeyRelease(data)) return;

		const mouseParsed = parseMouseWheelInput(data);
		if (mouseParsed === "mouse-other") {
			return;
		}
		if (mouseParsed) {
			if (this.pickerOpen) {
				this.movePickerBy(mouseParsed.direction, false);
				return;
			}
			const step = mouseParsed.alt
				? MOUSE_WHEEL_SCROLL_LINES * 3
				: MOUSE_WHEEL_SCROLL_LINES;
			this.scrollBy(mouseParsed.direction * step);
			return;
		}

		// Global toggle shortcut closes the overlay outside repeat-burst and post-mount guard windows
		if (matchesSessionDiffShortcutKey(data)) {
			if (isKeyRepeat(data)) {
				return;
			}
			if (this.onShortcutInput) {
				this.onShortcutInput();
				return;
			}
			const now = Date.now();
			const isRepeatBurst =
				now - this.lastShortcutInputAt < SHORTCUT_REPEAT_BURST_GAP_MS;
			this.lastShortcutInputAt = now;
			if (
				!isRepeatBurst &&
				!this.isWithinOpenGuard(OVERLAY_OPEN_CLOSE_GUARD_MS, now)
			) {
				this.close();
			}
			return;
		}

		// File Picker drawer navigation
		if (this.pickerOpen) {
			if (matchesKey(data, "up") || data === "k") {
				this.movePickerBy(-1, true);
				return;
			}
			if (matchesKey(data, "down") || data === "j") {
				this.movePickerBy(1, true);
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return")) {
				this.currentFileIndex = this.pickerIndex;
				this.scrollOffset = 0;
				this.pickerOpen = false;
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "escape") || data === "p" || data === "q") {
				if (!isKeyRepeat(data)) {
					this.pickerOpen = false;
					this.tui.requestRender();
				}
				return;
			}
			return;
		}

		// Diff View navigation
		if (
			matchesKey(data, "escape") ||
			data === "q" ||
			matchesKey(data, "ctrl+c")
		) {
			if (
				!isKeyRepeat(data) &&
				!this.isWithinOpenGuard(OVERLAY_OPEN_ESCAPE_GUARD_MS)
			) {
				this.close();
			}
			return;
		}

		const effectiveLayout = this.getEffectiveLayoutMode(this.tui.terminal?.columns ?? 100);
		const pageStep = Math.max(4, Math.floor(this.getViewportHeight(effectiveLayout) * 0.8));

		if (matchesKey(data, "down") || data === "j") {
			this.scrollBy(1);
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.scrollBy(-1);
			return;
		}
		if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) {
			this.scrollBy(pageStep);
			return;
		}
		if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
			this.scrollBy(-pageStep);
			return;
		}
		if (matchesKey(data, "home") || data === "g") {
			this.scrollOffset = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "end") || data === "G") {
			this.scrollOffset = Number.MAX_SAFE_INTEGER;
			this.tui.requestRender();
			return;
		}
		if (data === "n" || matchesKey(data, "right")) {
			this.jumpToNextHunk(1);
			this.tui.requestRender();
			return;
		}
		if (data === "N" || matchesKey(data, "left")) {
			this.jumpToNextHunk(-1);
			this.tui.requestRender();
			return;
		}
		if (data === "]" || matchesKey(data, "tab")) {
			this.switchFile(1);
			this.tui.requestRender();
			return;
		}
		if (data === "[" || matchesKey(data, "shift+tab")) {
			this.switchFile(-1);
			this.tui.requestRender();
			return;
		}
		if (data === "p") {
			if (!isKeyRepeat(data)) {
				this.pickerIndex = this.currentFileIndex;
				this.pickerOpen = true;
				this.scrollOffset = 0;
				this.tui.requestRender();
			}
			return;
		}
		if (data === "f") {
			this.viewMode = this.viewMode === "hunks" ? "full" : "hunks";
			this.scrollOffset = 0;
			this.tui.requestRender();
			return;
		}
		if (data === "u") {
			this.layoutMode = this.layoutMode === "split" ? "unified" : "split";
			this.scrollOffset = 0;
			this.tui.requestRender();
			return;
		}
		if (data === "r") {
			void this.refreshFromDisk();
			return;
		}
	}
}

// ============================================================================
// Step 3 & Step 6: State Manager, Tool Hooks, `/diff` Command & Shortcut Wiring
// ============================================================================

function isValidBaselineSnapshotEntry(data: unknown): data is BaselineSnapshotEntry {
	if (!data || typeof data !== "object") return false;
	const rec = data as Record<string, unknown>;
	return (
		typeof rec.relPath === "string" &&
		typeof rec.existedBefore === "boolean" &&
		(typeof rec.oldContent === "string" || rec.oldContent === null) &&
		typeof rec.isBinary === "boolean" &&
		typeof rec.tooLarge === "boolean" &&
		typeof rec.byteLength === "number" &&
		typeof rec.firstModifiedAt === "number" &&
		(rec.firstTool === undefined || rec.firstTool === "edit" || rec.firstTool === "write")
	);
}

function toBaselineSnapshotEntry(state: BaselineSnapshotEntry): BaselineSnapshotEntry {
	return {
		relPath: state.relPath,
		existedBefore: state.existedBefore,
		oldContent: state.oldContent,
		isBinary: state.isBinary,
		tooLarge: state.tooLarge,
		byteLength: state.byteLength,
		firstModifiedAt: state.firstModifiedAt,
		...(state.firstTool ? { firstTool: state.firstTool } : {}),
	};
}

function isValidTouchEntry(data: unknown): data is TouchEntry {
	if (!data || typeof data !== "object") return false;
	const rec = data as Record<string, unknown>;
	return (
		typeof rec.relPath === "string" &&
		(rec.toolName === "edit" || rec.toolName === "write") &&
		typeof rec.timestamp === "number"
	);
}

// ============================================================================
// Cross-Process Subagent Spool (Tier 1) & Message Fallback Recovery (Tier 2)
// ============================================================================

let childSpoolSeq = 0;

export function getSpoolDir(): string {
	return path.join(getAgentDir(), "session-diff", "spool");
}

export function isValidSubagentSpoolRecord(data: unknown): data is SubagentSpoolRecord {
	if (!data || typeof data !== "object") return false;
	const rec = data as Record<string, unknown>;
	return (
		typeof rec.id === "string" &&
		typeof rec.pid === "number" &&
		typeof rec.ppid === "number" &&
		typeof rec.toolCallId === "string" &&
		typeof rec.childCwd === "string" &&
		typeof rec.absPath === "string" &&
		(rec.toolName === "edit" || rec.toolName === "write") &&
		typeof rec.timestamp === "number" &&
		typeof rec.seq === "number" &&
		isValidBaselineSnapshotEntry(rec.baseline)
	);
}

export async function writeSubagentSpoolRecord(params: {
	toolCallId: string;
	childCwd: string;
	absPath: string;
	toolName: "edit" | "write";
	timestamp: number;
	baseline: BaselineSnapshotEntry;
}): Promise<void> {
	try {
		const seq = ++childSpoolSeq;
		const rand = Math.random().toString(36).slice(2, 10);
		const id = `${params.timestamp}-${process.pid}-${seq}-${rand}`;
		const record: SubagentSpoolRecord = {
			id,
			pid: process.pid,
			ppid: process.ppid,
			toolCallId: params.toolCallId,
			childCwd: params.childCwd,
			absPath: params.absPath,
			toolName: params.toolName,
			timestamp: params.timestamp,
			seq,
			baseline: params.baseline,
		};
		const spoolDir = getSpoolDir();
		await mkdir(spoolDir, { recursive: true });
		const tmpPath = path.join(spoolDir, `${id}.tmp`);
		const finalPath = path.join(spoolDir, `${id}.json`);
		await writeFile(tmpPath, JSON.stringify(record), "utf-8");
		await rename(tmpPath, finalPath);
	} catch {
		// Never allow spool I/O failures to disrupt tool execution
	}
}

export async function readCandidateSpoolRecords(
	now = Date.now(),
): Promise<Array<{ filePath: string; record: SubagentSpoolRecord }>> {
	const spoolDir = getSpoolDir();
	let entries: string[];
	try {
		entries = await readdir(spoolDir);
	} catch {
		return [];
	}

	const results: Array<{ filePath: string; record: SubagentSpoolRecord }> = [];
	for (const name of entries) {
		const fullPath = path.join(spoolDir, name);
		if (name.endsWith(".tmp")) {
			try {
				const st = await stat(fullPath);
				if (now - st.mtimeMs > SPOOL_MAX_AGE_MS) {
					await unlink(fullPath).catch(() => {});
				}
			} catch {
				// Ignore transient/deleted temp files
			}
			continue;
		}

		if (!name.endsWith(".json")) {
			continue;
		}

		try {
			const raw = await readFile(fullPath, "utf-8");
			const parsed: unknown = JSON.parse(raw);
			if (!isValidSubagentSpoolRecord(parsed)) {
				const st = await stat(fullPath);
				if (now - st.mtimeMs > SPOOL_MAX_AGE_MS) {
					await unlink(fullPath).catch(() => {});
				}
				continue;
			}
			if (now - parsed.timestamp > SPOOL_MAX_AGE_MS) {
				await unlink(fullPath).catch(() => {});
				continue;
			}
			results.push({ filePath: fullPath, record: parsed });
		} catch {
			// Ignore files being concurrently removed or unreadable
		}
	}

	return results;
}

function isPathEqualOrInside(childPath: string, parentPath: string): boolean {
	try {
		const cleanChild = canonicalizePathWithAncestors(path.resolve(cleanUserFilePath(childPath)));
		const cleanParent = canonicalizePathWithAncestors(path.resolve(cleanUserFilePath(parentPath)));
		const childKey = getPathLookupKey(cleanChild);
		const parentKey = getPathLookupKey(cleanParent);
		if (childKey === parentKey) return true;
		const prefix = parentKey.endsWith("/") ? parentKey : `${parentKey}/`;
		return childKey.startsWith(prefix);
	} catch {
		return false;
	}
}

export function matchSpoolRecordsForParent(
	candidates: Array<{ filePath: string; record: SubagentSpoolRecord }>,
	knownToolCallIds: Set<string>,
	expectedCwds: Set<string>,
	windowStart: number,
	windowEnd: number,
	hasActiveTimeWindow = false,
): Array<{ filePath: string; record: SubagentSpoolRecord }> {
	const ancestors = new Set<number>([process.pid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const { record } of candidates) {
			if (ancestors.has(record.ppid) && !ancestors.has(record.pid)) {
				ancestors.add(record.pid);
				changed = true;
			}
		}
	}

	const matched = candidates.filter(({ record }) => {
		if (knownToolCallIds.has(record.toolCallId)) {
			return true;
		}
		if (ancestors.has(record.ppid) && (!hasActiveTimeWindow || record.timestamp >= windowStart - 2000)) {
			return true;
		}
		if (
			hasActiveTimeWindow &&
			record.timestamp >= windowStart - 2000 &&
			record.timestamp <= windowEnd + 2000
		) {
			for (const expectedCwd of expectedCwds) {
				if (isPathEqualOrInside(record.childCwd, expectedCwd)) {
					return true;
				}
			}
		}
		return false;
	});

	matched.sort(
		(a, b) => a.record.timestamp - b.record.timestamp || a.record.seq - b.record.seq,
	);
	return matched;
}

function parseJsonObjectSafe(value: unknown): Record<string, unknown> | undefined {
	if (!value) return undefined;
	if (typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	if (typeof value === "string") {
		try {
			const parsed: unknown = JSON.parse(value);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function normalizeEditsArgument(
	args: Record<string, unknown>,
): Array<{ oldText: string; newText: string }> | undefined {
	let rawEdits: unknown = args.edits;
	if (typeof rawEdits === "string") {
		try {
			rawEdits = JSON.parse(rawEdits);
		} catch {
			rawEdits = undefined;
		}
	}

	const normalized: Array<{ oldText: string; newText: string }> = [];
	const pushIfValid = (item: unknown) => {
		if (!item || typeof item !== "object") return;
		const obj = item as Record<string, unknown>;
		const oldText =
			typeof obj.oldText === "string"
				? obj.oldText
				: typeof obj.old_text === "string"
					? obj.old_text
					: undefined;
		const newText =
			typeof obj.newText === "string"
				? obj.newText
				: typeof obj.new_text === "string"
					? obj.new_text
					: undefined;
		if (oldText !== undefined && newText !== undefined) {
			normalized.push({ oldText, newText });
		}
	};

	if (Array.isArray(rawEdits)) {
		for (const item of rawEdits) {
			pushIfValid(item);
		}
	} else if (rawEdits && typeof rawEdits === "object") {
		pushIfValid(rawEdits);
	}

	if (normalized.length === 0) {
		pushIfValid(args);
	}

	return normalized.length > 0 ? normalized : undefined;
}

function extractRawPathFromArgs(
	argsObj: Record<string, unknown> | undefined,
	rawArgsFallback?: unknown,
): string | undefined {
	if (argsObj) {
		const p =
			typeof argsObj.path === "string"
				? argsObj.path
				: typeof argsObj.file_path === "string"
					? argsObj.file_path
					: undefined;
		if (p && p.trim().length > 0) {
			return p;
		}
	}
	if (typeof rawArgsFallback === "string") {
		const match = rawArgsFallback.match(/"(?:path|file_path)"\s*:\s*"((?:\\.|[^"\\])+)"/);
		if (match?.[1]) {
			try {
				return JSON.parse(`"${match[1]}"`) as string;
			} catch {
				return match[1];
			}
		}
	}
	return undefined;
}

export function extractFileOpsFromSubagentDetails(
	details: unknown,
	fallbackCwd: string,
): { ops: ExtractedSubagentFileOp[]; childCwds: Set<string> } {
	const ops: ExtractedSubagentFileOp[] = [];
	const childCwds = new Set<string>([fallbackCwd]);
	if (!details || typeof details !== "object") {
		return { ops, childCwds };
	}

	const results = (details as { results?: unknown }).results;
	if (!Array.isArray(results)) {
		return { ops, childCwds };
	}

	for (const rawResult of results) {
		if (!rawResult || typeof rawResult !== "object") continue;
		const resultRecord = rawResult as Record<string, unknown>;
		const resultCwd =
			typeof resultRecord.cwd === "string" && resultRecord.cwd.trim().length > 0
				? resultRecord.cwd
				: fallbackCwd;
		childCwds.add(resultCwd);
		if (Array.isArray(resultRecord.messages)) {
			const extracted = extractFileOpsFromMessages(resultRecord.messages, resultCwd);
			ops.push(...extracted.ops);
			for (const childCwd of extracted.childCwds) {
				childCwds.add(childCwd);
			}
		}
	}

	return { ops, childCwds };
}

export function extractFileOpsFromMessages(
	messages: unknown[],
	defaultCwd: string,
): { ops: ExtractedSubagentFileOp[]; childCwds: Set<string> } {
	const ops: ExtractedSubagentFileOp[] = [];
	const childCwds = new Set<string>([defaultCwd]);
	if (!Array.isArray(messages)) {
		return { ops, childCwds };
	}

	interface IndexedToolCall {
		toolName: "edit" | "write";
		rawPath: string;
		timestamp: number;
		edits?: Array<{ oldText: string; newText: string }>;
		writeContent?: string;
	}

	const indexedCalls = new Map<string, IndexedToolCall>();

	for (const rawEntry of messages) {
		if (!rawEntry || typeof rawEntry !== "object") continue;
		const entryObj = rawEntry as Record<string, unknown>;
		const msgObj =
			entryObj.type === "message" && entryObj.message && typeof entryObj.message === "object"
				? (entryObj.message as Record<string, unknown>)
				: entryObj;

		const role = msgObj.role;
		const entryTimestamp =
			typeof msgObj.timestamp === "number"
				? msgObj.timestamp
				: typeof entryObj.timestamp === "number"
					? entryObj.timestamp
					: typeof entryObj.timestamp === "string"
						? Date.parse(entryObj.timestamp) || Date.now()
						: Date.now();

		if (role === "assistant" && Array.isArray(msgObj.content)) {
			for (const part of msgObj.content) {
				if (!part || typeof part !== "object") continue;
				const partObj = part as Record<string, unknown>;
				if (partObj.type !== "toolCall" || typeof partObj.id !== "string") continue;
				const name = partObj.name;
				if (name !== "edit" && name !== "write") continue;

				const argsObj = parseJsonObjectSafe(partObj.arguments);
				const rawPath = extractRawPathFromArgs(argsObj, partObj.arguments);
				if (!rawPath) continue;

				indexedCalls.set(partObj.id, {
					toolName: name,
					rawPath,
					timestamp: entryTimestamp,
					edits: name === "edit" && argsObj ? normalizeEditsArgument(argsObj) : undefined,
					writeContent:
						name === "write" && argsObj && typeof argsObj.content === "string"
							? argsObj.content
							: undefined,
				});
			}
			continue;
		}

		if (role === "toolResult") {
			const toolName = msgObj.toolName;
			const isError = Boolean(msgObj.isError);
			const toolCallId = typeof msgObj.toolCallId === "string" ? msgObj.toolCallId : "";

			if ((toolName === "edit" || toolName === "write") && !isError && toolCallId) {
				const call = indexedCalls.get(toolCallId);
				if (call) {
					ops.push({
						toolCallId,
						toolName: call.toolName,
						rawPath: call.rawPath,
						cwd: defaultCwd,
						timestamp: entryTimestamp,
						edits: call.edits,
						writeContent: call.writeContent,
					});
				}
				continue;
			}

			if (toolName === "codemode") {
				const nestedList: unknown[] = Array.isArray(msgObj.nestedCalls)
					? msgObj.nestedCalls
					: Array.isArray((msgObj.nestedCalls as { calls?: unknown } | undefined)?.calls)
						? (msgObj.nestedCalls as { calls: unknown[] }).calls
						: Array.isArray((msgObj.details as { calls?: unknown } | undefined)?.calls)
							? (msgObj.details as { calls: unknown[] }).calls
							: [];

				for (let idx = 0; idx < nestedList.length; idx++) {
					const rawCall = nestedList[idx];
					if (!rawCall || typeof rawCall !== "object") continue;
					const callObj = rawCall as Record<string, unknown>;
					if (callObj.status !== "ok") continue;
					const nestedToolName = callObj.name;
					if (nestedToolName !== "edit" && nestedToolName !== "write") continue;

					const rawArgs = callObj.arguments ?? callObj.args;
					const argsObj = parseJsonObjectSafe(rawArgs);
					const rawPath = extractRawPathFromArgs(argsObj, rawArgs);
					if (!rawPath) continue;

					const nestedToolCallId =
						typeof callObj.id === "string" && callObj.id.length > 0
							? callObj.id
							: `${toolCallId || "codemode"}:${idx}`;

					ops.push({
						toolCallId: nestedToolCallId,
						toolName: nestedToolName,
						rawPath,
						cwd: defaultCwd,
						timestamp: entryTimestamp,
						edits:
							nestedToolName === "edit" && argsObj
								? normalizeEditsArgument(argsObj)
								: undefined,
						writeContent:
							nestedToolName === "write" &&
							argsObj &&
							typeof argsObj.content === "string"
								? argsObj.content
								: undefined,
					});
				}
				continue;
			}

			if (toolName === "subagent" || toolName === "swarm_resume") {
				const nested = extractFileOpsFromSubagentDetails(msgObj.details, defaultCwd);
				ops.push(...nested.ops);
				for (const childCwd of nested.childCwds) {
					childCwds.add(childCwd);
				}
			}
		}
	}

	return { ops, childCwds };
}

export function extractBranchFileOps(
	ctx: ExtensionContext,
): { ops: ExtractedSubagentFileOp[]; childCwds: Set<string> } {
	const branchEntries = ctx.sessionManager?.getBranch?.() ?? [];
	const messageEntries = branchEntries.filter(
		(entry) =>
			entry &&
			typeof entry === "object" &&
			(entry as { type?: string }).type === "message",
	);
	return extractFileOpsFromMessages(messageEntries, ctx.cwd);
}

export async function reconstructBaselineFromOps(
	absPath: string,
	relPath: string,
	ops: ExtractedSubagentFileOp[],
): Promise<BaselineSnapshotEntry> {
	const current = await readFileSnapshot(absPath);
	const firstModifiedAt = ops[0]?.timestamp ?? Date.now();
	const firstTool: "edit" | "write" = ops[0]?.toolName ?? "edit";

	if (ops.length > 0 && ops[0].toolName === "write") {
		return {
			relPath,
			existedBefore: false,
			oldContent: null,
			isBinary: current.isBinary,
			tooLarge: current.tooLarge,
			byteLength: 0,
			firstModifiedAt,
			firstTool,
		};
	}

	if (current.exists && current.content !== null) {
		let text = current.content;
		for (let i = ops.length - 1; i >= 0; i--) {
			const op = ops[i];
			if (op.toolName === "edit" && op.edits && op.edits.length > 0) {
				for (let j = op.edits.length - 1; j >= 0; j--) {
					const edit = op.edits[j];
					const normOld = edit.oldText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
					const normNew = edit.newText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
					if (normNew.length > 0) {
						const foundIdx = text.indexOf(normNew);
						if (foundIdx !== -1) {
							text =
								text.slice(0, foundIdx) +
								normOld +
								text.slice(foundIdx + normNew.length);
						}
					}
				}
			}
		}
		return {
			relPath,
			existedBefore: true,
			oldContent: text,
			isBinary: false,
			tooLarge: false,
			byteLength: Buffer.byteLength(text, "utf-8"),
			firstModifiedAt,
			firstTool,
		};
	}

	return {
		relPath,
		existedBefore: current.exists,
		oldContent: current.content,
		isBinary: current.isBinary,
		tooLarge: current.tooLarge,
		byteLength: current.byteLength,
		firstModifiedAt,
		firstTool,
	};
}

export default function sessionDiffExtension(pi: ExtensionAPI): void {
	const trackedFiles = new Map<string, TrackedFileState>();
	const pendingCaptures = new Map<string, PendingCapture>();
	const pendingSubagents = new Map<string, PendingSubagentCall>();
	const ingestedToolCallIds = new Set<string>();
	const consumedSpoolIds = new Set<string>();

	let latestContext: ExtensionContext | undefined;
	let activeOverlayInstance: SessionDiffOverlay | undefined;
	let activeOverlayTui: TUI | undefined;
	let mouseTrackingEnabledByOverlay = false;
	let isOpeningOverlay = false;
	let lastShortcutEventAt = 0;
	let lastSyncedLeafId: string | null | undefined = undefined;
	let unsubscribeTerminalInput: (() => void) | undefined;

	const onProcessExitRestoreMouse = (): void => {
		if (!mouseTrackingEnabledByOverlay) {
			return;
		}
		mouseTrackingEnabledByOverlay = false;
		try {
			process.stdout.write(DISABLE_MOUSE_TRACKING_SEQ);
		} catch {
			// Ignore write errors during process teardown
		}
	};

	function enableOverlayMouseTracking(tui: TUI): void {
		activeOverlayTui = tui;
		if (tui.mode === "fullscreen" || mouseTrackingEnabledByOverlay) {
			return;
		}
		try {
			tui.terminal?.write?.(ENABLE_MOUSE_TRACKING_SEQ);
			mouseTrackingEnabledByOverlay = true;
			process.once("exit", onProcessExitRestoreMouse);
		} catch {
			// Ignore terminal write errors
		}
	}

	function disableOverlayMouseTracking(tui?: TUI): void {
		process.off("exit", onProcessExitRestoreMouse);
		const targetTui = tui ?? activeOverlayTui;
		activeOverlayTui = undefined;
		if (!mouseTrackingEnabledByOverlay) {
			return;
		}
		mouseTrackingEnabledByOverlay = false;
		if (targetTui?.mode === "fullscreen") {
			return;
		}
		try {
			if (targetTui?.terminal?.write) {
				targetTui.terminal.write(DISABLE_MOUSE_TRACKING_SEQ);
			} else {
				process.stdout.write(DISABLE_MOUSE_TRACKING_SEQ);
			}
		} catch {
			// Ignore terminal write errors
		}
	}

	function cleanupTerminalInputListener(): void {
		if (unsubscribeTerminalInput) {
			unsubscribeTerminalInput();
			unsubscribeTerminalInput = undefined;
		}
	}

	function commitTrackedBaselineOrTouch(
		baseline: BaselineSnapshotEntry,
		toolName: "edit" | "write",
		timestamp: number,
		persistToSession: boolean,
	): void {
		if (isSwarmBlackboardPath(baseline.relPath)) {
			return;
		}
		const key = getPathLookupKey(baseline.relPath);
		const existing = trackedFiles.get(key);
		const canPersist =
			persistToSession && (!latestContext || !isSubagentChildProcess(latestContext));

		if (!existing) {
			const baselineWithTool: BaselineSnapshotEntry = {
				...baseline,
				firstTool: baseline.firstTool ?? toolName,
			};
			const state: TrackedFileState = {
				...baselineWithTool,
				editCount: 1,
				lastModifiedAt: timestamp,
				lastTool: toolName,
			};
			trackedFiles.set(key, state);
			if (canPersist) {
				pi.appendEntry<BaselineSnapshotEntry>(BASELINE_ENTRY_TYPE, baselineWithTool);
			}
		} else {
			existing.editCount += 1;
			existing.lastModifiedAt = timestamp;
			existing.lastTool = toolName;
			if (canPersist) {
				pi.appendEntry<TouchEntry>(TOUCH_ENTRY_TYPE, {
					relPath: existing.relPath,
					toolName,
					timestamp,
				});
			}
		}
	}

	function reconstructState(ctx: ExtensionContext, clearPending = false): void {
		latestContext = ctx;
		const previousTracked = clearPending ? undefined : new Map(trackedFiles);
		trackedFiles.clear();
		if (clearPending) {
			pendingCaptures.clear();
			pendingSubagents.clear();
			ingestedToolCallIds.clear();
			consumedSpoolIds.clear();
		}

		const branchEntries = ctx.sessionManager?.getBranch?.() ?? [];
		for (const entry of branchEntries) {
			if (entry.type !== "custom") continue;
			if (
				entry.customType === BASELINE_ENTRY_TYPE &&
				isValidBaselineSnapshotEntry(entry.data)
			) {
				if (isSwarmBlackboardPath(entry.data.relPath)) continue;
				const key = getPathLookupKey(entry.data.relPath);
				if (!trackedFiles.has(key)) {
					const firstTool = entry.data.firstTool ?? "edit";
					trackedFiles.set(key, {
						...entry.data,
						firstTool,
						editCount: 1,
						lastModifiedAt: entry.data.firstModifiedAt,
						lastTool: firstTool,
					});
				}
			} else if (
				entry.customType === TOUCH_ENTRY_TYPE &&
				isValidTouchEntry(entry.data)
			) {
				if (isSwarmBlackboardPath(entry.data.relPath)) continue;
				const key = getPathLookupKey(entry.data.relPath);
				const existing = trackedFiles.get(key);
				if (existing) {
					existing.editCount += 1;
					existing.lastModifiedAt = entry.data.timestamp;
					existing.lastTool = entry.data.toolName;
				}
			}
		}

		if (clearPending && trackedFiles.size > 0) {
			const { ops: branchOps } = extractBranchFileOps(ctx);
			const opsByKey = new Map<string, ExtractedSubagentFileOp[]>();
			for (const op of branchOps) {
				const resolvedInChild = normalizeSessionFilePath(op.rawPath, op.cwd || ctx.cwd);
				const { relPath } = normalizeSessionFilePath(resolvedInChild.absPath, ctx.cwd);
				const key = getPathLookupKey(relPath);
				if (!trackedFiles.has(key)) continue;
				let list = opsByKey.get(key);
				if (!list) {
					list = [];
					opsByKey.set(key, list);
				}
				list.push(op);
			}
			for (const [key, list] of opsByKey.entries()) {
				const existing = trackedFiles.get(key);
				if (!existing) continue;
				list.sort((a, b) => a.timestamp - b.timestamp);
				const persistedCount = Math.min(list.length, existing.editCount);
				for (let i = 0; i < persistedCount; i++) {
					ingestedToolCallIds.add(list[i].toolCallId);
				}
			}
		}

		if (previousTracked) {
			for (const [key, prevState] of previousTracked.entries()) {
				const branchState = trackedFiles.get(key);
				if (!branchState) {
					trackedFiles.set(key, prevState);
				} else if (prevState.editCount > branchState.editCount) {
					branchState.editCount = prevState.editCount;
					branchState.lastModifiedAt = Math.max(
						branchState.lastModifiedAt,
						prevState.lastModifiedAt,
					);
					branchState.lastTool = prevState.lastTool;
				}
			}
		}
	}

	async function ingestExtractedFileOps(
		ctx: ExtensionContext,
		ops: ExtractedSubagentFileOp[],
		options: { skipAlreadyTrackedFiles?: boolean; writeChildSpool?: boolean } = {},
	): Promise<void> {
		if (ops.length === 0) {
			return;
		}

		const opsByFile = new Map<
			string,
			{ absPath: string; relPath: string; fileOps: ExtractedSubagentFileOp[] }
		>();

		for (const op of ops) {
			if (ingestedToolCallIds.has(op.toolCallId)) {
				continue;
			}
			const resolvedInChild = normalizeSessionFilePath(op.rawPath, op.cwd);
			const { absPath, relPath } = normalizeSessionFilePath(resolvedInChild.absPath, ctx.cwd);
			if (isSwarmBlackboardPath(relPath)) {
				ingestedToolCallIds.add(op.toolCallId);
				continue;
			}
			const key = getPathLookupKey(relPath);
			let group = opsByFile.get(key);
			if (!group) {
				group = { absPath, relPath, fileOps: [] };
				opsByFile.set(key, group);
			}
			group.fileOps.push(op);
		}

		for (const [key, group] of opsByFile.entries()) {
			if (options.skipAlreadyTrackedFiles && trackedFiles.has(key)) {
				for (const op of group.fileOps) {
					ingestedToolCallIds.add(op.toolCallId);
				}
				continue;
			}

			group.fileOps.sort((a, b) => a.timestamp - b.timestamp);
			const existing = trackedFiles.get(key);
			const baseline: BaselineSnapshotEntry = existing
				? toBaselineSnapshotEntry(existing)
				: await reconstructBaselineFromOps(group.absPath, group.relPath, group.fileOps);

			for (const op of group.fileOps) {
				commitTrackedBaselineOrTouch(baseline, op.toolName, op.timestamp, true);
				ingestedToolCallIds.add(op.toolCallId);
				if (options.writeChildSpool && isSubagentChildProcess(ctx)) {
					await writeSubagentSpoolRecord({
						toolCallId: op.toolCallId,
						childCwd: ctx.cwd,
						absPath: group.absPath,
						toolName: op.toolName,
						timestamp: op.timestamp,
						baseline,
					});
				}
			}
		}
	}

	async function ingestSubagentChanges(
		ctx: ExtensionContext,
		subagentDetails?: unknown,
		windowStart?: number,
		windowEnd?: number,
	): Promise<void> {
		if (isSubagentChildProcess(ctx)) {
			return;
		}

		const hasActiveTimeWindow = windowStart !== undefined;
		const extracted =
			subagentDetails !== undefined
				? extractFileOpsFromSubagentDetails(subagentDetails, ctx.cwd)
				: extractBranchFileOps(ctx);
		const ops = extracted.ops;
		const expectedCwds = new Set<string>(extracted.childCwds);

		let minPendingStart = Number.MAX_SAFE_INTEGER;
		for (const pending of pendingSubagents.values()) {
			expectedCwds.add(pending.cwd);
			if (pending.startedAt < minPendingStart) {
				minPendingStart = pending.startedAt;
			}
		}

		const now = Date.now();
		const effectiveStart =
			windowStart ?? (minPendingStart < Number.MAX_SAFE_INTEGER ? minPendingStart : now - SPOOL_MAX_AGE_MS);
		const effectiveEnd = windowEnd ?? now;
		const knownToolCallIds = new Set<string>(ops.map((o) => o.toolCallId));

		const candidates = await readCandidateSpoolRecords(now);
		const matchedSpools = matchSpoolRecordsForParent(
			candidates,
			knownToolCallIds,
			expectedCwds,
			effectiveStart,
			effectiveEnd,
			hasActiveTimeWindow,
		).filter((item) => !consumedSpoolIds.has(item.record.id));

		interface ReconcileFileBucket {
			absPath: string;
			relPath: string;
			fileSpools: Array<{ filePath: string; record: SubagentSpoolRecord }>;
			fileOps: ExtractedSubagentFileOp[];
		}

		const fileBuckets = new Map<string, ReconcileFileBucket>();

		for (const item of matchedSpools) {
			const { absPath, relPath } = normalizeSessionFilePath(item.record.absPath, ctx.cwd);
			if (isSwarmBlackboardPath(relPath)) {
				continue;
			}
			const key = getPathLookupKey(relPath);
			let bucket = fileBuckets.get(key);
			if (!bucket) {
				bucket = { absPath, relPath, fileSpools: [], fileOps: [] };
				fileBuckets.set(key, bucket);
			}
			bucket.fileSpools.push(item);
		}

		for (const op of ops) {
			const resolvedInChild = normalizeSessionFilePath(op.rawPath, op.cwd || ctx.cwd);
			const { absPath, relPath } = normalizeSessionFilePath(resolvedInChild.absPath, ctx.cwd);
			if (isSwarmBlackboardPath(relPath)) {
				ingestedToolCallIds.add(op.toolCallId);
				continue;
			}
			const key = getPathLookupKey(relPath);
			let bucket = fileBuckets.get(key);
			if (!bucket) {
				bucket = { absPath, relPath, fileSpools: [], fileOps: [] };
				fileBuckets.set(key, bucket);
			}
			bucket.fileOps.push(op);
		}

		for (const [key, bucket] of fileBuckets.entries()) {
			bucket.fileSpools.sort(
				(a, b) => a.record.timestamp - b.record.timestamp || a.record.seq - b.record.seq,
			);
			bucket.fileOps.sort((a, b) => a.timestamp - b.timestamp);

			const unifiedByCallId = new Map<
				string,
				{ toolCallId: string; toolName: "edit" | "write"; timestamp: number; seq: number }
			>();

			for (const { record } of bucket.fileSpools) {
				if (ingestedToolCallIds.has(record.toolCallId)) {
					continue;
				}
				if (!unifiedByCallId.has(record.toolCallId)) {
					unifiedByCallId.set(record.toolCallId, {
						toolCallId: record.toolCallId,
						toolName: record.toolName,
						timestamp: record.timestamp,
						seq: record.seq,
					});
				}
			}

			for (const op of bucket.fileOps) {
				if (ingestedToolCallIds.has(op.toolCallId)) {
					continue;
				}
				if (!unifiedByCallId.has(op.toolCallId)) {
					unifiedByCallId.set(op.toolCallId, {
						toolCallId: op.toolCallId,
						toolName: op.toolName,
						timestamp: op.timestamp,
						seq: Number.MAX_SAFE_INTEGER,
					});
				}
			}

			const uningestedOps = Array.from(unifiedByCallId.values()).sort(
				(a, b) => a.timestamp - b.timestamp || a.seq - b.seq,
			);

			if (uningestedOps.length === 0) {
				continue;
			}

			let baseline: BaselineSnapshotEntry;
			const existing = trackedFiles.get(key);
			if (existing) {
				baseline = toBaselineSnapshotEntry(existing);
			} else {
				const firstSpool = bucket.fileSpools[0];
				const firstOp = bucket.fileOps[0];
				if (
					firstSpool &&
					(!firstOp ||
						firstSpool.record.toolCallId === firstOp.toolCallId ||
						firstSpool.record.timestamp <= firstOp.timestamp + 5000)
				) {
					baseline = {
						...firstSpool.record.baseline,
						relPath: bucket.relPath,
						firstTool:
							firstSpool.record.baseline.firstTool ?? firstSpool.record.toolName,
					};
				} else {
					baseline = await reconstructBaselineFromOps(
						bucket.absPath,
						bucket.relPath,
						bucket.fileOps,
					);
				}
			}

			for (const op of uningestedOps) {
				commitTrackedBaselineOrTouch(baseline, op.toolName, op.timestamp, true);
				ingestedToolCallIds.add(op.toolCallId);
			}
		}

		for (const item of matchedSpools) {
			consumedSpoolIds.add(item.record.id);
			ingestedToolCallIds.add(item.record.toolCallId);
			await unlink(item.filePath).catch(() => {});
		}
	}

	async function syncSessionDiffState(
		ctx: ExtensionContext,
		clearPending: boolean,
		forceFullRescan = false,
	): Promise<void> {
		latestContext = ctx;
		if (clearPending) {
			lastSyncedLeafId = undefined;
		}

		const currentLeafId = ctx.sessionManager?.getLeafId?.() ?? null;
		const canUseFastPath =
			!clearPending &&
			!forceFullRescan &&
			trackedFiles.size > 0 &&
			pendingSubagents.size === 0 &&
			lastSyncedLeafId !== undefined &&
			currentLeafId === lastSyncedLeafId;

		if (canUseFastPath) {
			if (isSubagentChildProcess(ctx)) {
				return;
			}
			const candidates = await readCandidateSpoolRecords();
			const hasUnconsumedSpool = candidates.some(
				(item) => !consumedSpoolIds.has(item.record.id),
			);
			if (!hasUnconsumedSpool) {
				return;
			}
		}

		reconstructState(ctx, clearPending);
		await ingestSubagentChanges(ctx);
		lastSyncedLeafId = ctx.sessionManager?.getLeafId?.() ?? null;
	}

	function handleShortcutTrigger(ctx: ExtensionContext): void {
		const prevShortcutAt = lastShortcutEventAt;
		const now = Date.now();
		lastShortcutEventAt = now;
		const isRepeatBurst = now - prevShortcutAt < SHORTCUT_REPEAT_BURST_GAP_MS;

		if (isOpeningOverlay) {
			return;
		}

		if (activeOverlayInstance) {
			if (
				isRepeatBurst ||
				activeOverlayInstance.isWithinOpenGuard(OVERLAY_OPEN_CLOSE_GUARD_MS, now)
			) {
				return;
			}
			activeOverlayInstance.close();
			return;
		}

		if (isRepeatBurst) {
			return;
		}

		void openDiffViewer(latestContext ?? ctx);
	}

	function attachTerminalShortcutInterceptor(ctx: ExtensionContext): void {
		cleanupTerminalInputListener();
		if (!ctx.hasUI || ctx.mode !== "tui" || typeof ctx.ui?.onTerminalInput !== "function") {
			return;
		}
		unsubscribeTerminalInput = ctx.ui.onTerminalInput((data: string) => {
			if (matchesSessionDiffShortcutKey(data)) {
				if (isKeyRelease(data) || isKeyRepeat(data)) {
					return { consume: true };
				}
				handleShortcutTrigger(latestContext ?? ctx);
				return { consume: true };
			}
			return undefined;
		});
	}

	async function openDiffViewer(
		ctx: ExtensionContext,
		initialFilter?: string,
	): Promise<void> {
		latestContext = ctx;
		if (!ctx.hasUI || ctx.mode !== "tui") {
			return;
		}

		// Toggle/close if already open
		if (activeOverlayInstance) {
			if (
				activeOverlayInstance.isWithinOpenGuard(OVERLAY_OPEN_CLOSE_GUARD_MS)
			) {
				return;
			}
			activeOverlayInstance.close();
			return;
		}
		if (isOpeningOverlay) {
			return;
		}

		isOpeningOverlay = true;
		try {
			await syncSessionDiffState(ctx, false);

			if (trackedFiles.size === 0) {
				ctx.ui.notify("No files modified by edit/write in this session branch yet.", "info");
				return;
			}

			const states = Array.from(trackedFiles.values());
			let initialIndex = 0;

			if (initialFilter && initialFilter.trim().length > 0) {
				const needle = initialFilter.trim();
				const needleLower = needle.toLowerCase();
				const exactIdx = states.findIndex(
					(s) => s.relPath.toLowerCase() === needleLower,
				);
				if (exactIdx >= 0) {
					initialIndex = exactIdx;
				} else {
					const subIdx = states.findIndex((s) =>
						s.relPath.toLowerCase().includes(needleLower),
					);
					if (subIdx >= 0) {
						initialIndex = subIdx;
					} else {
						ctx.ui.notify(
							`No tracked file matches "${needle}". Showing ${states[0].relPath}.`,
							"warning",
						);
					}
				}
			}

			const initialDiffs = await Promise.all(
				states.map((st) => computeFileDiff(st, ctx.cwd)),
			);

			const overlayOptions: OverlayOptions = {
				anchor: "center",
				width: "96%",
				minWidth: 44,
				maxHeight: "92%",
				margin: 1,
			};

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					enableOverlayMouseTracking(tui);
					const overlay = new SessionDiffOverlay(
						tui,
						theme,
						ctx.cwd,
						() => Array.from(trackedFiles.values()),
						initialDiffs,
						initialIndex,
						() => {
							disableOverlayMouseTracking(tui);
							activeOverlayInstance = undefined;
							isOpeningOverlay = false;
							done(undefined);
						},
						async () => {
							await syncSessionDiffState(ctx, false, true);
							return Array.from(trackedFiles.values());
						},
						() => {
							handleShortcutTrigger(latestContext ?? ctx);
						},
						() => {
							isOpeningOverlay = false;
							lastShortcutEventAt = Date.now();
						},
						() => {
							disableOverlayMouseTracking(tui);
						},
					);
					activeOverlayInstance = overlay;
					return overlay;
				},
				{
					overlay: true,
					overlayOptions: () => overlayOptions,
					onHandle: () => {
						activeOverlayInstance?.markMounted();
						isOpeningOverlay = false;
						lastShortcutEventAt = Date.now();
					},
				},
			);
		} finally {
			disableOverlayMouseTracking();
			isOpeningOverlay = false;
			activeOverlayInstance = undefined;
		}
	}

	// Phase 1: Pre-Execution Capture
	pi.on("tool_call", async (event, ctx) => {
		latestContext = ctx;
		if (event.toolName === "subagent" || event.toolName === "swarm_resume") {
			pendingSubagents.set(event.toolCallId, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				startedAt: Date.now(),
				cwd: ctx.cwd,
			});
			return;
		}

		const isEdit = isToolCallEventType("edit", event);
		const isWrite = isToolCallEventType("write", event);
		if (!isEdit && !isWrite) {
			return;
		}

		const rawPath = event.input?.path;
		if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
			return;
		}

		const toolName: "edit" | "write" = isEdit ? "edit" : "write";
		const { absPath, relPath } = normalizeSessionFilePath(rawPath, ctx.cwd);
		if (isSwarmBlackboardPath(relPath)) {
			return;
		}
		const key = getPathLookupKey(relPath);

		const existing = trackedFiles.get(key);
		if (existing) {
			pendingCaptures.set(event.toolCallId, {
				relPath: existing.relPath,
				absPath,
				toolName,
			});
			return;
		}

		const snapshot = await readFileSnapshot(absPath);
		const baseline: BaselineSnapshotEntry = {
			relPath,
			existedBefore: snapshot.exists,
			oldContent: snapshot.content,
			isBinary: snapshot.isBinary,
			tooLarge: snapshot.tooLarge,
			byteLength: snapshot.byteLength,
			firstModifiedAt: Date.now(),
			firstTool: toolName,
		};

		pendingCaptures.set(event.toolCallId, {
			relPath,
			absPath,
			toolName,
			baseline,
		});
	});

	// Phase 2: Commit on Success
	pi.on("tool_result", async (event, ctx) => {
		latestContext = ctx;
		if (
			event.toolName === "subagent" ||
			event.toolName === "swarm_resume" ||
			pendingSubagents.has(event.toolCallId)
		) {
			const pendingSubagent = pendingSubagents.get(event.toolCallId);
			pendingSubagents.delete(event.toolCallId);
			await ingestSubagentChanges(
				ctx,
				(event as { details?: unknown }).details,
				pendingSubagent?.startedAt ?? 0,
				Date.now(),
			);
			return;
		}

		if (event.toolName === "codemode") {
			const { ops } = extractFileOpsFromMessages(
				[
					{
						role: "toolResult",
						toolName: "codemode",
						toolCallId: event.toolCallId,
						isError: event.isError,
						nestedCalls: (event as { nestedCalls?: unknown }).nestedCalls,
						details: (event as { details?: unknown }).details,
						timestamp: Date.now(),
					},
				],
				ctx.cwd,
			);
			await ingestExtractedFileOps(ctx, ops, {
				skipAlreadyTrackedFiles: false,
				writeChildSpool: true,
			});
			return;
		}

		const pending = pendingCaptures.get(event.toolCallId);
		pendingCaptures.delete(event.toolCallId);
		if (!pending) {
			return;
		}

		if (!(isEditToolResult(event) || isWriteToolResult(event)) || event.isError) {
			return;
		}

		const key = getPathLookupKey(pending.relPath);
		const now = Date.now();
		const existing = trackedFiles.get(key);
		const baselineToCommit: BaselineSnapshotEntry | undefined = existing
			? toBaselineSnapshotEntry(existing)
			: pending.baseline;

		if (!baselineToCommit) {
			return;
		}

		commitTrackedBaselineOrTouch(baselineToCommit, pending.toolName, now, true);
		ingestedToolCallIds.add(event.toolCallId);

		if (isSubagentChildProcess(ctx)) {
			await writeSubagentSpoolRecord({
				toolCallId: event.toolCallId,
				childCwd: ctx.cwd,
				absPath: pending.absPath,
				toolName: pending.toolName,
				timestamp: now,
				baseline: baselineToCommit,
			});
		}
	});

	// Session Lifecycle Hooks
	pi.on("session_start", async (_event, ctx) => {
		await syncSessionDiffState(ctx, true);
		attachTerminalShortcutInterceptor(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await syncSessionDiffState(ctx, true);
	});

	pi.on("session_shutdown", async () => {
		cleanupTerminalInputListener();
		disableOverlayMouseTracking();
		activeOverlayInstance = undefined;
		isOpeningOverlay = false;
		lastShortcutEventAt = 0;
		lastSyncedLeafId = undefined;
	});

	// Slash Command `/diff`
	pi.registerCommand("diff", {
		description: "Open side-by-side session diff viewer (Left = Old, Right = New)",
		getArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
			const prefix = argumentPrefix.trim().toLowerCase();
			const items: AutocompleteItem[] = [];
			for (const state of trackedFiles.values()) {
				if (prefix.length === 0 || state.relPath.toLowerCase().includes(prefix)) {
					items.push({
						value: state.relPath,
						label: state.relPath,
						description: `${state.lastTool} (${state.editCount}x)`,
					});
				}
			}
			return items.length > 0 ? items : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await openDiffViewer(ctx, args.trim() || undefined);
		},
	});

	// Keyboard Shortcut `ctrl+alt+d`
	pi.registerShortcut(SESSION_DIFF_SHORTCUT, {
		description: "Open session side-by-side diff viewer",
		handler: async (ctx: ExtensionContext) => {
			handleShortcutTrigger(ctx);
		},
	});
}
