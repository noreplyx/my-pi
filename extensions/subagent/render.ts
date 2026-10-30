/**
 * Shared rendering primitives for the subagent TUI.
 *
 * Single implementation of: tool-call preview, result badges, wall-time
 * totals, and display-item truncation — used by all mode renderers
 * in index.ts so collapsed/expanded output stays consistent.
 */
import * as os from "node:os";
import { formatReadLineRange } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { SingleResult } from "./types.ts";
import { aggregateUsage, formatDuration, formatUsageStats, getFinalOutput, isFailedResult } from "./utils.ts";

export const COLLAPSED_ITEM_COUNT = 10;

export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const lineRange = formatReadLineRange(args.offset, args.limit);
			let text = themeFg("accent", filePath);
			if (lineRange) {
				text += themeFg("warning", lineRange);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

export type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

export function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

/** Truncate a task preview for renderCall (single shared implementation). */
export function truncatePreview(text: string, max = 60): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}...`;
}

/** `[errorCode]` + `⏱ duration` badges shared by every renderer. */
export function resultBadges(r: SingleResult): { errorBadge: string; durationBadge: string } {
	const failed = isFailedResult(r);
	return {
		errorBadge: failed && r.errorCode && r.errorCode !== "ok" ? ` [${r.errorCode}]` : "",
		durationBadge: r.durationMs > 0 ? ` ⏱ ${formatDuration(r.durationMs)}` : "",
	};
}

/**
 * Unified totals line. Wall semantics are explicit and consistent:
 * parallel/swarm take the max (concurrent).
 */
export function formatTotals(results: SingleResult[]): string {
	const usageStr = formatUsageStats(aggregateUsage(results));
	const wallMs = Math.max(0, ...results.map((r) => r.durationMs || 0));
	const wallStr = wallMs > 0 ? `wall (max) ${formatDuration(wallMs)}` : "";
	return [usageStr, wallStr].filter(Boolean).join(" | ");
}

export function totalsSuffix(results: SingleResult[]): string {
	const t = formatTotals(results);
	return t ? `Total: ${t}` : "";
}

/** One-line worker row used by parallel/swarm renderers. */
export function workerRowLabel(r: SingleResult, label: string): { icon: "ok" | "fail" | "running"; text: string } {
	if (r.exitCode === -1) return { icon: "running", text: `${label} ${r.agent} (running...)` };
	if (isFailedResult(r)) {
		const { errorBadge, durationBadge } = resultBadges(r);
		return { icon: "fail", text: `${label} ${r.agent}${errorBadge}${durationBadge}` };
	}
	const { durationBadge } = resultBadges(r);
	return { icon: "ok", text: `${label} ${r.agent}${durationBadge}` };
}
