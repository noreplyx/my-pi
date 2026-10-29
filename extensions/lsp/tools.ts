/**
 * Model-facing LSP tools. All read-only, UI-independent, fail-closed.
 * Positions from the model are 1-based; LSP is 0-based.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUPPORTED_LANGUAGES, languageFromFile, type SupportedLanguage } from "./config.js";
import { uriToPath, pathToUri } from "./client.js";
import type { LspManager } from "./manager.js";

const MAX_ITEMS = 50;
const MAX_CHARS = 8000;

const LanguageEnum = Type.Union([
	Type.Literal("csharp"),
	Type.Literal("python"),
	Type.Literal("typescript"),
]);

const LANGUAGE_INFERENCE_NOTE =
	"`language` may be omitted when `file` has known extension (.cs/.py/.ts/.tsx/.js/.jsx/.mjs/.cjs); inferred automatically. If both given and disagree, the call fails.";

const OptionalLanguage = Type.Optional(
	Type.Union([Type.Literal("csharp"), Type.Literal("python"), Type.Literal("typescript")], {
		description: `Language server to use. ${LANGUAGE_INFERENCE_NOTE}`,
	}),
);

/**
 * STRICT auto-detection fallback: explicit wins only when it matches inference
 * (or when no inference is possible). Mismatches and uninferrable files are errors.
 */
export function resolveLanguage(
	explicit: SupportedLanguage | undefined,
	fileAbs: string | undefined,
):
	| { language: SupportedLanguage }
	| { error: string; inferred?: SupportedLanguage; explicit?: SupportedLanguage; file?: string } {
	const inferred = fileAbs ? languageFromFile(fileAbs) : undefined;
	if (explicit && inferred) {
		if (explicit !== inferred) {
			return {
				error: `Language mismatch: inferred ${inferred} but got ${explicit} for file ${fileAbs}; pass matching language or omit language to use inference.`,
				inferred,
				explicit,
				file: fileAbs,
			};
		}
		return { language: explicit };
	}
	if (explicit) return { language: explicit };
	if (inferred) return { language: inferred };
	if (fileAbs) {
		return {
			error: `Cannot infer language from file ${fileAbs}; pass language explicitly: csharp|python|typescript`,
			file: fileAbs,
		};
	}
	return {
		error: `Cannot infer language: no file and no language provided; pass language explicitly: csharp|python|typescript`,
	};
}

function isResolutionErrorMessage(message: string): boolean {
	return message.startsWith("Language mismatch:") || message.startsWith("Cannot infer language");
}

function resolutionDetails(err: unknown): Record<string, unknown> {
	const d = (err as { details?: unknown } | undefined)?.details;
	return d !== null && typeof d === "object" ? (d as Record<string, unknown>) : {};
}

const PositionParams = (extra: Record<string, unknown> = {}) =>
	Type.Object({
		language: OptionalLanguage,
		file: Type.String({ description: "Workspace-relative or absolute file path" }),
		line: Type.Number({ description: "1-based line number" }),
		character: Type.Number({ description: "1-based character/column number" }),
		...extra,
	});

const LocationSchema = Type.Object({
	uri: Type.String(),
	path: Type.String(),
	line: Type.Number({ description: "1-based line" }),
	character: Type.Number({ description: "1-based character" }),
});

function toOneBased(line: number, character: number): { line: number; character: number } {
	return { line: line + 1, character: character + 1 };
}

function normalizeLocation(raw: unknown): { uri: string; line: number; character: number } | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;
	// Location | LocationLink shapes
	const uri = typeof obj.uri === "string" ? obj.uri : typeof obj.targetUri === "string" ? obj.targetUri : undefined;
	const range =
		(obj.range as { start?: { line?: number; character?: number } } | undefined) ??
		(obj.targetSelectionRange as { start?: { line?: number; character?: number } } | undefined) ??
		(obj.targetRange as { start?: { line?: number; character?: number } } | undefined);
	if (!uri || typeof range?.start?.line !== "number") return undefined;
	const one = toOneBased(range.start.line, range.start.character ?? 0);
	return { uri, ...one };
}

function asLocationList(raw: unknown): { uri: string; line: number; character: number }[] {
	const items = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
	const out: { uri: string; line: number; character: number }[] = [];
	for (const item of items) {
		const loc = normalizeLocation(item);
		if (loc) out.push(loc);
	}
	return out.slice(0, MAX_ITEMS);
}

function toZeroBased(line: number, character: number): { line: number; character: number } | { error: string } {
	if (!Number.isFinite(line) || !Number.isFinite(character)) {
		return { error: `Invalid position: line=${String(line)} character=${String(character)} (expected 1-based numbers)` };
	}
	if (Math.floor(line) < 1 || Math.floor(character) < 1) {
		return { error: `Invalid position: line=${String(line)} character=${String(character)} (1-based, must be >= 1)` };
	}
	return { line: Math.max(0, Math.floor(line) - 1), character: Math.max(0, Math.floor(character) - 1) };
}

function hoverText(raw: unknown): string {
	if (raw == null) return "";
	if (typeof raw === "object") {
		const obj = raw as Record<string, unknown>;
		const contents = obj.contents as unknown;
		if (typeof contents === "string") return contents;
		if (Array.isArray(contents)) {
			return contents
				.map((c) => (typeof c === "string" ? c : (c as { value?: string }).value ?? JSON.stringify(c)))
				.join("\n---\n");
		}
		if (contents && typeof contents === "object") {
			return (contents as { value?: string }).value ?? JSON.stringify(contents);
		}
		return JSON.stringify(obj);
	}
	return String(raw);
}

function truncate(text: string): { text: string; truncated: boolean } {
	if (text.length <= MAX_CHARS) return { text, truncated: false };
	return { text: `${text.slice(0, MAX_CHARS)}\n…[truncated ${text.length - MAX_CHARS} chars]`, truncated: true };
}

async function resolveFile(cwd: string, file: string): Promise<string> {
	const abs = path.isAbsolute(file) ? file : path.join(cwd, file);
	try {
		return await fs.realpath(abs).catch(() => abs);
	} catch {
		return abs;
	}
}

function okResult(text: string, structured: unknown, details: Record<string, unknown>) {
	const t = truncate(text);
	return {
		content: [{ type: "text" as const, text: t.text }],
		details: { ...details, truncated: t.truncated },
		structuredContent: structured as never,
	};
}

// Note: structuredContent `{ error }` intentionally bypasses each tool's success outputSchema
// via `as never`. Fail-closed errors use isError + details.error; success schemas stay strict.
function errResult(message: string, details: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: { ...details, error: message },
		structuredContent: { error: message } as never,
		isError: true as const,
	};
}

export function registerLspTools(pi: ExtensionAPI, manager: LspManager, getCwd: () => string): void {
	const withClient = async (
		explicit: SupportedLanguage | undefined,
		file: string | undefined,
		signal: AbortSignal | undefined,
	) => {
		const cwd = getCwd();
		const abs = file ? await resolveFile(cwd, file) : path.join(cwd, ".");
		const resolved = resolveLanguage(explicit, file ? abs : undefined);
		if ("error" in resolved) {
			const err = new Error(resolved.error);
			(err as unknown as { details: unknown }).details = resolved;
			throw err;
		}
		const language = resolved.language;
		let text = "";
		if (file) {
			try {
				text = await fs.readFile(abs, "utf8");
			} catch (err) {
				throw new Error(`Cannot read file ${abs}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		if (signal?.aborted) throw new Error("aborted");
		return manager.ensure(language, abs, text, signal);
	};

	pi.registerTool({
		name: "lsp_hover",
		label: "LSP hover",
		description:
			"Hover type info at a 1-based line/character. Opens the file in the language server first. `language` may be omitted when `file` has known extension (.cs/.py/.ts/.tsx/.js/.jsx/.mjs/.cjs); inferred automatically. If both given and disagree, the call fails.",
		parameters: PositionParams(),
		annotations: { readOnlyHint: true },
		outputSchema: Type.Object({ text: Type.String(), uri: Type.String() }),
		async execute(_id, params, signal) {
			try {
				const pos = toZeroBased(params.line, params.character);
				if ("error" in pos) return errResult(pos.error, { tool: "lsp_hover" });
				const { client, uri } = await withClient(params.language, params.file, signal);
				const raw = await client.hover(uri, pos.line, pos.character, signal);
				if (!raw) return okResult("No hover information.", { text: "", uri }, { tool: "lsp_hover" });
				const text = hoverText(raw);
				return okResult(text || "No hover information.", { text, uri }, { tool: "lsp_hover" });
			} catch (err) {
				if (err instanceof Error && err.message === "aborted") throw err;
				if (err instanceof Error && isResolutionErrorMessage(err.message)) {
					return errResult(err.message, { tool: "lsp_hover", ...resolutionDetails(err) });
				}
				return errResult(`Hover failed: ${err instanceof Error ? err.message : String(err)}`, {
					tool: "lsp_hover",
				});
			}
		},
	});

	pi.registerTool({
		name: "lsp_definition",
		label: "LSP definition",
		description:
			"Go-to-definition at a 1-based position. Returns 1-based locations. `language` may be omitted when `file` has known extension (.cs/.py/.ts/.tsx/.js/.jsx/.mjs/.cjs); inferred automatically. If both given and disagree, the call fails.",
		parameters: PositionParams(),
		annotations: { readOnlyHint: true },
		outputSchema: Type.Object({ locations: Type.Array(LocationSchema) }),
		async execute(_id, params, signal) {
			try {
				const pos = toZeroBased(params.line, params.character);
				if ("error" in pos) return errResult(pos.error, { tool: "lsp_definition" });
				const { client, uri } = await withClient(params.language, params.file, signal);
				const raw = await client.definition(uri, pos.line, pos.character, signal);
				const locs = asLocationList(raw).map((l) => ({ ...l, path: uriToPath(l.uri) }));
				if (locs.length === 0) {
					return okResult("No definitions found.", { locations: [] }, { tool: "lsp_definition" });
				}
				const text = locs.map((l) => `${l.path}:${l.line}:${l.character}`).join("\n");
				return okResult(text, { locations: locs }, { tool: "lsp_definition", count: locs.length });
			} catch (err) {
				if (err instanceof Error && err.message === "aborted") throw err;
				if (err instanceof Error && isResolutionErrorMessage(err.message)) {
					return errResult(err.message, { tool: "lsp_definition", ...resolutionDetails(err) });
				}
				return errResult(`Definition failed: ${err instanceof Error ? err.message : String(err)}`, {
					tool: "lsp_definition",
				});
			}
		},
	});

	pi.registerTool({
		name: "lsp_references",
		label: "LSP references",
		description:
			"Find references at a 1-based position. Returns up to 50 1-based locations. `language` may be omitted when `file` has known extension (.cs/.py/.ts/.tsx/.js/.jsx/.mjs/.cjs); inferred automatically. If both given and disagree, the call fails.",
		parameters: PositionParams({
			includeDeclaration: Type.Optional(Type.Boolean({ description: "Include the declaration itself" })),
		}),
		annotations: { readOnlyHint: true },
		outputSchema: Type.Object({ locations: Type.Array(LocationSchema) }),
		async execute(_id, params, signal) {
			try {
				const pos = toZeroBased(params.line, params.character);
				if ("error" in pos) return errResult(pos.error, { tool: "lsp_references" });
				const { client, uri } = await withClient(params.language, params.file, signal);
				const raw = await client.references(
					uri,
					pos.line,
					pos.character,
					(params as { includeDeclaration?: boolean }).includeDeclaration ?? false,
					signal,
				);
				const locs = asLocationList(raw).map((l) => ({ ...l, path: uriToPath(l.uri) }));
				if (locs.length === 0) {
					return okResult("No references found.", { locations: [] }, { tool: "lsp_references" });
				}
				const text = locs.map((l) => `${l.path}:${l.line}:${l.character}`).join("\n");
				return okResult(
					`${locs.length} reference(s):\n${text}`,
					{ locations: locs },
					{ tool: "lsp_references", count: locs.length },
				);
			} catch (err) {
				if (err instanceof Error && err.message === "aborted") throw err;
				if (err instanceof Error && isResolutionErrorMessage(err.message)) {
					return errResult(err.message, { tool: "lsp_references", ...resolutionDetails(err) });
				}
				return errResult(`References failed: ${err instanceof Error ? err.message : String(err)}`, {
					tool: "lsp_references",
				});
			}
		},
	});

	pi.registerTool({
		name: "lsp_diagnostics",
		label: "LSP diagnostics",
		description:
			"Cached publishDiagnostics for a file, or all files when file is omitted. `language` may be omitted when `file` has known extension (.cs/.py/.ts/.tsx/.js/.jsx/.mjs/.cjs); inferred automatically. If both given and disagree, the call fails.",
		parameters: Type.Object({
			language: OptionalLanguage,
			file: Type.Optional(Type.String({ description: "File path; omit for all open diagnostics" })),
		}),
		annotations: { readOnlyHint: true },
		outputSchema: Type.Object({
			diagnostics: Type.Array(
				Type.Object({
					uri: Type.String(),
					path: Type.String(),
					line: Type.Number(),
					character: Type.Number(),
					message: Type.String(),
					severity: Type.Optional(Type.Number()),
				}),
			),
		}),
		async execute(_id, params, signal) {
			try {
				const { client } = await withClient(params.language, params.file, signal);
				// Ensure the requested file is open so its diagnostics arrive.
				if (params.file) {
					const cwd = getCwd();
					const abs = await resolveFile(cwd, params.file);
					let text: string;
					try {
						text = await fs.readFile(abs, "utf8");
					} catch (err) {
						return errResult(`Cannot read file ${abs}: ${err instanceof Error ? err.message : String(err)}`, { tool: "lsp_diagnostics" });
					}
					await client.ensureOpen(abs, text);
					// Poll for publishDiagnostics up to ~2s; cache returns immediately otherwise.
					const deadline = Date.now() + 2000;
					for (;;) {
						if (signal?.aborted) throw new Error("aborted");
						const pending = client.getDiagnostics(pathToUri(abs));
						if (pending.length > 0) break;
						if (Date.now() >= deadline) break;
						await new Promise((r) => setTimeout(r, 50));
					}
					if (signal?.aborted) throw new Error("aborted");
				}
				const targetUri = params.file
					? pathToUri(await resolveFile(getCwd(), params.file))
					: undefined;
				const raw = client.getDiagnostics(targetUri).slice(0, MAX_ITEMS);
				const mapped = raw.map((d) => {
					const one = toOneBased(d.range.start.line, d.range.start.character);
					return {
						uri: d.uri,
						path: uriToPath(d.uri),
						line: one.line,
						character: one.character,
						message: d.message,
						severity: d.severity,
					};
				});
				if (mapped.length === 0) return okResult("No diagnostics.", { diagnostics: [] }, { tool: "lsp_diagnostics" });
				const text = mapped.map((d) => `${d.path}:${d.line}:${d.character} ${d.message}`).join("\n");
				return okResult(text, { diagnostics: mapped }, { tool: "lsp_diagnostics", count: mapped.length });
			} catch (err) {
				if (err instanceof Error && err.message === "aborted") throw err;
				if (err instanceof Error && isResolutionErrorMessage(err.message)) {
					return errResult(err.message, { tool: "lsp_diagnostics", ...resolutionDetails(err) });
				}
				return errResult(`Diagnostics failed: ${err instanceof Error ? err.message : String(err)}`, {
					tool: "lsp_diagnostics",
				});
			}
		},
	});

	pi.registerTool({
		name: "lsp_document_symbols",
		label: "LSP document symbols",
		description:
			"Outline symbols for a file (classes, functions, methods). `language` may be omitted when `file` has known extension (.cs/.py/.ts/.tsx/.js/.jsx/.mjs/.cjs); inferred automatically. If both given and disagree, the call fails.",
		parameters: Type.Object({ language: OptionalLanguage, file: Type.String() }),
		annotations: { readOnlyHint: true },
		outputSchema: Type.Object({ symbols: Type.Array(Type.Unknown()) }),
		async execute(_id, params, signal) {
			try {
				const { client, uri } = await withClient(params.language, params.file, signal);
				const raw = await client.documentSymbol(uri, signal);
				const items = (Array.isArray(raw) ? raw : []).slice(0, MAX_ITEMS);
				if (items.length === 0) {
					return okResult("No symbols found.", { symbols: [] }, { tool: "lsp_document_symbols" });
				}
				const names = items.map((s) => {
					const o = s as Record<string, unknown>;
					return `- ${String(o.name ?? "?")} (${String(o.kind ?? "?")})`;
				});
				return okResult(names.join("\n"), { symbols: items }, { tool: "lsp_document_symbols", count: items.length });
			} catch (err) {
				if (err instanceof Error && err.message === "aborted") throw err;
				if (err instanceof Error && isResolutionErrorMessage(err.message)) {
					return errResult(err.message, { tool: "lsp_document_symbols", ...resolutionDetails(err) });
				}
				return errResult(`Document symbols failed: ${err instanceof Error ? err.message : String(err)}`, {
					tool: "lsp_document_symbols",
				});
			}
		},
	});

	pi.registerTool({
		name: "lsp_workspace_symbols",
		label: "LSP workspace symbols",
		description: "Search symbols across the project root. Query is a substring.",
		parameters: Type.Object({ language: LanguageEnum, query: Type.String() }),
		annotations: { readOnlyHint: true },
		outputSchema: Type.Object({ symbols: Type.Array(Type.Unknown()) }),
		async execute(_id, params, signal) {
			try {
				// Workspace search needs a rooted client; anchor on cwd.
				const { client } = await withClient(params.language, undefined, signal);
				const raw = await client.workspaceSymbol(params.query, signal);
				const items = (Array.isArray(raw) ? raw : []).slice(0, MAX_ITEMS);
				if (items.length === 0) {
					return okResult(`No workspace symbols for "${params.query}".`, { symbols: [] }, {
						tool: "lsp_workspace_symbols",
					});
				}
				const lines = items.map((s) => {
					const o = s as Record<string, unknown>;
					const loc = normalizeLocation(o.location);
					const at = loc ? ` — ${uriToPath(loc.uri)}:${loc.line}:${loc.character}` : "";
					return `- ${String(o.name ?? "?")}${at}`;
				});
				return okResult(lines.join("\n"), { symbols: items }, {
					tool: "lsp_workspace_symbols",
					count: items.length,
				});
			} catch (err) {
				if (err instanceof Error && err.message === "aborted") throw err;
				return errResult(`Workspace symbols failed: ${err instanceof Error ? err.message : String(err)}`, {
					tool: "lsp_workspace_symbols",
				});
			}
		},
	});

	void SUPPORTED_LANGUAGES;
}
