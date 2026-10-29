/**
 * LSP extension configuration: defaults + merge of `lsp.json`
 * beside the extension directory or at `<cwd>/.pi/lsp.json`.
 */
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import * as path from "node:path";

export type SupportedLanguage = "csharp" | "python" | "typescript";

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = ["csharp", "python", "typescript"];

export interface ServerConfig {
	command: string;
	args: string[];
	rootMarkers: string[];
	enabled: boolean;
	env?: Record<string, string>;
}

export interface LspConfig {
	autoStart: boolean;
	servers: Record<SupportedLanguage, ServerConfig>;
}

export const DEFAULT_CONFIG: LspConfig = {
	autoStart: false,
	servers: {
		csharp: {
			command: "csharp-language-server",
			args: [],
			rootMarkers: ["*.sln", "*.csproj", "global.json"],
			enabled: true,
		},
		python: {
			command: "pylsp",
			args: [],
			rootMarkers: ["pyproject.toml", "requirements.txt", "setup.py", ".git"],
			enabled: true,
		},
		typescript: {
			command: "typescript-language-server",
			args: ["--stdio"],
			rootMarkers: ["tsconfig.json", "package.json", "jsconfig.json"],
			enabled: true,
		},
	},
};

export const INSTALL_HINTS: Record<SupportedLanguage, string> = {
	csharp:
		"C# server missing. Download a standalone binary from https://github.com/razzmatazz/csharp-language-server/releases, put it on PATH as csharp-language-server \u2014 OR use OmniSharp: download from https://github.com/OmniSharp/omnisharp-roslyn/releases and set command to OmniSharp with args [-lsp].",
	python:
		"Install Python: `pipx install python-lsp-server` (alt: `npm i -g pyright` + `pyright-langserver --stdio`).",
	typescript:
		"Install TypeScript: `npm i -g typescript-language-server typescript`.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function mergeServer(base: ServerConfig, override: unknown): ServerConfig {
	if (!isRecord(override)) return base;
	return {
		command: typeof override.command === "string" ? override.command : base.command,
		args: Array.isArray(override.args) ? override.args.map(String) : base.args,
		rootMarkers: Array.isArray(override.rootMarkers)
			? override.rootMarkers.map(String)
			: base.rootMarkers,
		enabled: typeof override.enabled === "boolean" ? override.enabled : base.enabled,
		env: isRecord(override.env)
			? Object.fromEntries(Object.entries(override.env).map(([k, v]) => [k, String(v)]))
			: base.env,
	};
}

async function readJsonIfExists(
	file: string,
): Promise<{ parsed?: Record<string, unknown>; missing: boolean; warning?: string }> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { missing: true };
		return { missing: false, warning: `LSP config unreadable at ${file}: ${err instanceof Error ? err.message : String(err)}` };
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isRecord(parsed)) return { missing: false, warning: `LSP config malformed at ${file}: expected a JSON object` };
		return { parsed, missing: false };
	} catch (err) {
		return { missing: false, warning: `LSP config malformed at ${file}: ${err instanceof Error ? err.message : String(err)}` };
	}
}

/** Load defaults, then overlay `lsp.json` beside the extension, then `<cwd>/.pi/lsp.json`. */
export async function loadLspConfig(
	extensionDir: string,
	cwd: string,
): Promise<{ config: LspConfig; sources: string[]; warnings: string[] }> {
	const config: LspConfig = structuredClone(DEFAULT_CONFIG);
	const sources: string[] = [];
	const warnings: string[] = [];
	for (const file of [path.join(extensionDir, "lsp.json"), path.join(cwd, ".pi", "lsp.json")]) {
		const { parsed, warning } = await readJsonIfExists(file);
		if (warning) warnings.push(warning);
		if (!parsed) continue;
		sources.push(file);
		if (typeof parsed.autoStart === "boolean") config.autoStart = parsed.autoStart;
		const servers = isRecord(parsed.servers) ? parsed.servers : undefined;
		if (!servers) continue;
		for (const lang of SUPPORTED_LANGUAGES) {
			if (servers[lang] !== undefined) {
				config.servers[lang] = mergeServer(config.servers[lang], servers[lang]);
			}
		}
	}
	return { config, sources, warnings };
}

export function languageFromFile(filePath: string): SupportedLanguage | undefined {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".cs") return "csharp";
	if (ext === ".py" || ext === ".pyi") return "python";
	if (
		ext === ".ts" ||
		ext === ".tsx" ||
		ext === ".js" ||
		ext === ".jsx" ||
		ext === ".mjs" ||
		ext === ".cjs" ||
		ext === ".mts" ||
		ext === ".cts"
	) {
		return "typescript";
	}
	return undefined;
}

async function isExecutableFile(file: string): Promise<boolean> {
	try {
		await access(file, constants.X_OK);
		return (await stat(file)).isFile();
	} catch {
		return false;
	}
}

export function isExecutableOnPath(command: string): Promise<boolean> {
	if (command.includes("/") || command.includes("\\")) {
		return isExecutableFile(command);
	}
	const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const names =
		process.platform === "win32" ? [command, `${command}.exe`, `${command}.cmd`] : [command];
	return (async () => {
		for (const dir of dirs) {
			for (const name of names) {
				if (await isExecutableFile(path.join(dir, name))) return true;
			}
		}
		return false;
	})();
}

/** Fail-closed helper: which enabled servers have a missing binary? */
export async function findMissingBinaries(config: LspConfig): Promise<{ lang: SupportedLanguage; hint: string }[]> {
	const missing: { lang: SupportedLanguage; hint: string }[] = [];
	for (const lang of SUPPORTED_LANGUAGES) {
		const server = config.servers[lang];
		if (!server.enabled) continue;
		if (!(await isExecutableOnPath(server.command))) {
			missing.push({ lang, hint: `${server.command} not found on PATH. ${INSTALL_HINTS[lang]}` });
		}
	}
	return missing;
}
