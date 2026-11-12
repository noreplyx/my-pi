/**
 * LSP extension configuration: defaults + merge of `lsp.json`
 * beside the extension directory or at `<cwd>/.pi/lsp.json`.
 */
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import * as path from "node:path";

export type SupportedLanguage =
	| "csharp"
	| "python"
	| "typescript"
	| "javascript"
	| "bash"
	| "shell"
	| "lua"
	| "powershell";

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
	"csharp",
	"python",
	"typescript",
	"javascript",
	"bash",
	"shell",
	"lua",
	"powershell",
];

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
		javascript: {
			command: "typescript-language-server",
			args: ["--stdio"],
			rootMarkers: ["package.json", "jsconfig.json", "tsconfig.json", ".git"],
			enabled: true,
		},
		bash: {
			command: "bash-language-server",
			args: ["start"],
			rootMarkers: [".shellcheckrc", ".git"],
			enabled: true,
		},
		shell: {
			command: "bash-language-server",
			args: ["start"],
			rootMarkers: [".shellcheckrc", ".git"],
			enabled: true,
		},
		lua: {
			command: "lua-language-server",
			args: [],
			rootMarkers: [".luarc.json", ".luarc.jsonc", ".luacheckrc", "stylua.toml", ".stylua.toml", ".git"],
			enabled: true,
		},
		powershell: {
			command: "powershell-editor-services",
			args: ["-Stdio"],
			rootMarkers: ["*.psd1", ".git"],
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
	javascript:
		"Install JavaScript LSP: `npm i -g typescript-language-server typescript` (or use Mason `vtsls --stdio`).",
	bash:
		"Install Bash LSP: `npm i -g bash-language-server` (optional: install `shellcheck` and `shfmt` on PATH for richer diagnostics/formatting).",
	shell:
		"Install Shell LSP: `npm i -g bash-language-server` (supports sh/bash/zsh; optional: `shellcheck` and `shfmt` on PATH).",
	lua:
		"Install Lua LSP: download `lua-language-server` from https://github.com/LuaLS/lua-language-server/releases or add `%LOCALAPPDATA%\\nvim-data\\mason\\bin` to PATH.",
	powershell:
		"Install PowerShell Editor Services: download PowerShellEditorServices release zip from https://github.com/PowerShell/PowerShellEditorServices/releases and expose a `powershell-editor-services` wrapper on PATH (or configure `servers.powershell` in `lsp.json` to invoke `powershell.exe -NoLogo -NoProfile -NonInteractive -Command \"& '<path>/Start-EditorServices.ps1' -Stdio ...\"`).",
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

export interface FileLanguageInfo {
	language: SupportedLanguage;
	languageId: string;
}

export function resolveFileLanguageInfo(filePath: string): FileLanguageInfo | undefined {
	const base = path.basename(filePath).toLowerCase();
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".cs") return { language: "csharp", languageId: "csharp" };
	if (ext === ".py" || ext === ".pyi") return { language: "python", languageId: "python" };
	if (ext === ".tsx") return { language: "typescript", languageId: "typescriptreact" };
	if (ext === ".ts" || ext === ".mts" || ext === ".cts") return { language: "typescript", languageId: "typescript" };
	if (ext === ".jsx") return { language: "javascript", languageId: "javascriptreact" };
	if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return { language: "javascript", languageId: "javascript" };
	if (ext === ".bash" || base === ".bashrc" || base === ".bash_profile" || base === ".bash_aliases") {
		return { language: "bash", languageId: "shellscript" };
	}
	if (
		ext === ".sh" ||
		ext === ".zsh" ||
		base === ".zshrc" ||
		base === ".zshenv" ||
		base === ".zprofile" ||
		base === ".profile"
	) {
		return { language: "shell", languageId: "shellscript" };
	}
	if (ext === ".lua") return { language: "lua", languageId: "lua" };
	if (ext === ".ps1" || ext === ".psm1" || ext === ".psd1") {
		return { language: "powershell", languageId: "powershell" };
	}
	return undefined;
}

export function languageFromFile(filePath: string): SupportedLanguage | undefined {
	return resolveFileLanguageInfo(filePath)?.language;
}

async function isExecutableFile(file: string): Promise<boolean> {
	try {
		await access(file, constants.X_OK);
		return (await stat(file)).isFile();
	} catch {
		return false;
	}
}

export async function resolveExecutableOnPath(command: string): Promise<string | undefined> {
	const executableExtensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
	if (command.includes("/") || command.includes("\\")) {
		for (const ext of executableExtensions) {
			const candidate = `${command}${ext}`;
			if (await isExecutableFile(candidate)) return candidate;
		}
		return undefined;
	}
	const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const fallbackDirs: string[] = [];
	if (process.platform === "win32" && process.env.LOCALAPPDATA) {
		const masonRoot = path.join(process.env.LOCALAPPDATA, "nvim-data", "mason");
		fallbackDirs.push(
			path.join(masonRoot, "packages", command, "bin"),
			path.join(masonRoot, "bin"),
		);
	}
	for (const dir of [...pathDirs, ...fallbackDirs]) {
		for (const ext of executableExtensions) {
			const candidate = path.join(dir, `${command}${ext}`);
			if (await isExecutableFile(candidate)) return candidate;
		}
	}
	return undefined;
}

export async function isExecutableOnPath(command: string): Promise<boolean> {
	return (await resolveExecutableOnPath(command)) !== undefined;
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
