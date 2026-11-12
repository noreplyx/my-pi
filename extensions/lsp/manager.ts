/**
 * Lazily starts one LspClient per (language, project root).
 * Root detection walks up looking for language markers.
 */
import { existsSync, promises as fs, readdirSync } from "node:fs";
import * as path from "node:path";
import {
	INSTALL_HINTS,
	resolveExecutableOnPath,
	type LspConfig,
	type SupportedLanguage,
} from "./config.js";
import { LspClient, pathToUri } from "./client.js";

function markerMatches(dir: string, marker: string): boolean {
	if (marker.startsWith("*")) {
		try {
			const entries = existsSync(dir) ? readdirSync(dir) : [];
			const suffix = marker.slice(1);
			return entries.some((e) => e.endsWith(suffix));
		} catch {
			return false;
		}
	}
	return existsSync(path.join(dir, marker));
}

export function findRoot(startFile: string, markers: string[]): string {
	let dir = path.dirname(path.resolve(startFile));
	for (;;) {
		if (markers.some((m) => markerMatches(dir, m))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return path.dirname(path.resolve(startFile));
		dir = parent;
	}
}

export interface ClientStatus {
	language: SupportedLanguage;
	root: string;
	running: boolean;
	openFiles: number;
	diagnosticUris: number;
}

export type ExecutableAvailabilityCheck = (command: string) => Promise<boolean>;
export type PathCheck = ExecutableAvailabilityCheck;

export class LspManager {
	private readonly clients = new Map<string, LspClient>();
	private stoppingPromise: Promise<void> | undefined;

	constructor(
		private config: LspConfig,
		private readonly executableAvailabilityCheck?: ExecutableAvailabilityCheck,
	) {}

	setConfig(config: LspConfig): void {
		this.config = config;
	}

	getConfig(): LspConfig {
		return this.config;
	}

	private hasMatchingCommandAndArgs(first: SupportedLanguage, second: SupportedLanguage): boolean {
		const firstServer = this.config.servers[first];
		const secondServer = this.config.servers[second];
		return (
			firstServer.command === secondServer.command &&
			firstServer.args.length === secondServer.args.length &&
			firstServer.args.every((arg, index) => arg === secondServer.args[index])
		);
	}

	private canonicalLanguage(language: SupportedLanguage): SupportedLanguage {
		if (language === "javascript" && this.hasMatchingCommandAndArgs("javascript", "typescript")) {
			return "typescript";
		}
		if (language === "shell" && this.hasMatchingCommandAndArgs("shell", "bash")) {
			return "bash";
		}
		return language;
	}

	private key(language: SupportedLanguage, root: string): string {
		return `${this.canonicalLanguage(language)}:${root}`;
	}

	rootFor(language: SupportedLanguage, filePath: string): string {
		const canonical = this.canonicalLanguage(language);
		return findRoot(filePath, this.config.servers[canonical].rootMarkers);
	}

	/** Lazy per (lang, root). Throws a fail-closed error when disabled or binary missing. */
	async ensure(
		language: SupportedLanguage,
		filePath: string,
		fileText?: string,
		signal?: AbortSignal,
	): Promise<{ client: LspClient; uri: string }> {
		const server = this.config.servers[language];
		if (!server.enabled) {
			throw new Error(`LSP for ${language} is disabled in lsp.json (servers.${language}.enabled=false).`);
		}
		if (signal?.aborted) throw new Error("aborted");
		let resolvedCommand: string | undefined;
		if (this.executableAvailabilityCheck) {
			if (!(await this.executableAvailabilityCheck(server.command))) {
				throw new Error(`${server.command} not found on PATH. ${INSTALL_HINTS[language]}`);
			}
			resolvedCommand = (await resolveExecutableOnPath(server.command)) ?? server.command;
		} else {
			resolvedCommand = await resolveExecutableOnPath(server.command);
			if (!resolvedCommand) {
				throw new Error(`${server.command} not found on PATH. ${INSTALL_HINTS[language]}`);
			}
		}
		if (signal?.aborted) throw new Error("aborted");
		const root = this.rootFor(language, filePath);
		const key = this.key(language, root);
		let client = this.clients.get(key);
		if (!client) {
			client = new LspClient({
				command: resolvedCommand,
				args: server.args,
				rootUri: pathToUri(root),
				rootPath: root,
				env: server.env,
			});
			this.clients.set(key, client);
		}
		try {
			await client.ensureInitialized();
		} catch (err) {
			this.clients.delete(key);
			throw new Error(
				`Could not start ${server.command} for ${language}: ${err instanceof Error ? err.message : String(err)}. ${INSTALL_HINTS[language]}`,
			);
		}
		const text = fileText ?? (await readTextBestEffort(filePath));
		const uri = await client.ensureOpen(filePath, text);
		return { client, uri };
	}

	status(): ClientStatus[] {
		return [...this.clients.entries()].map(([key, client]) => {
			const sep = key.indexOf(":");
			return {
				language: key.slice(0, sep) as SupportedLanguage,
				root: key.slice(sep + 1),
				running: client.running,
				openFiles: client.openFileCount(),
				diagnosticUris: client.diagnosticUris().length,
			};
		});
	}

	async restart(language?: SupportedLanguage): Promise<void> {
		const canonicalTarget = language ? this.canonicalLanguage(language) : undefined;
		const targets = [...this.clients.entries()].filter(
			([key]) =>
				!language ||
				key.startsWith(`${language}:`) ||
				(canonicalTarget !== undefined && key.startsWith(`${canonicalTarget}:`)),
		);
		await Promise.all(
			targets.map(async ([key, client]) => {
				await client.stop().catch(() => undefined);
				this.clients.delete(key);
			}),
		);
	}

	/** Idempotent: safe to call from shutdown, reload, and /lsp-stop. Concurrent callers coalesce. */
	stopAll(): Promise<void> {
		if (this.stoppingPromise) return this.stoppingPromise;
		this.stoppingPromise = (async () => {
			try {
				await Promise.all([...this.clients.values()].map((c) => c.stop().catch(() => undefined)));
				this.clients.clear();
			} finally {
				this.stoppingPromise = undefined;
			}
		})();
		return this.stoppingPromise;
	}
}

async function readTextBestEffort(filePath: string): Promise<string> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch {
		return "";
	}
}
