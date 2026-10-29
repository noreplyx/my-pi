/**
 * Single LSP server connection over stdio.
 * Spawns lazily, queues requests until `initialize` completes,
 * caches `publishDiagnostics`, honors AbortSignal.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { encodeMessage, LspFraming, PendingRequests } from "./protocol.js";

export interface Diagnostic {
	uri: string;
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
	severity?: number;
	message: string;
	source?: string;
}

export interface LspClientOptions {
	command: string;
	args: string[];
	rootUri: string;
	rootPath: string;
	env?: Record<string, string>;
	onDiagnostics?: (uri: string, diagnostics: Diagnostic[]) => void;
	onLog?: (message: string) => void;
}

let globalId = 1;

export function pathToUri(filePath: string): string {
	return pathToFileURL(path.resolve(filePath)).toString();
}

export function uriToPath(uri: string): string {
	try {
		const url = new URL(uri);
		if (url.protocol !== "file:") return uri;
		return decodeURIComponent(url.pathname);
	} catch {
		return uri;
	}
}

export class LspClient {
	readonly rootPath: string;
	readonly rootUri: string;
	private readonly options: LspClientOptions;
	private proc: ChildProcess | undefined;
	private readonly framing = new LspFraming();
	private readonly pending = new PendingRequests();
	private nextId = globalId++;
	private initPromise: Promise<void> | undefined;
	private initialized = false;
	private stopped = false;
	private stderrTail = "";
	private readonly openFiles = new Map<string, { version: number; languageId: string; text: string }>();
	private readonly diagnostics = new Map<string, Diagnostic[]>();

	constructor(options: LspClientOptions) {
		this.options = options;
		this.rootPath = options.rootPath;
		this.rootUri = options.rootUri;
	}

	get running(): boolean {
		return this.proc !== undefined && this.proc.exitCode === null && !this.stopped;
	}

	openFileCount(): number {
		return this.openFiles.size;
	}

	private stdinWritable(): boolean {
		return !!this.proc && this.running && !!this.proc.stdin?.writable;
	}

	private log(message: string): void {
		this.options.onLog?.(message);
	}

	start(): void {
		if (this.proc) return;
		this.stopped = false;
		const proc = spawn(this.options.command, this.options.args, {
			cwd: this.options.rootPath,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc = proc;
		proc.stdin?.on("error", (err) => {
			this.pending.rejectAll(err instanceof Error ? err : new Error(String(err)));
			this.log(`LSP stdin error: ${String(err)}`);
		});
		proc.stdout?.on("data", (chunk: Buffer) => this.handleData(chunk));
		proc.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-2000);
		});
		proc.on("error", (err) => {
			this.pending.rejectAll(err instanceof Error ? err : new Error(String(err)));
			this.log(`LSP spawn failed: ${String(err)}`);
		});
		proc.on("exit", (code, signal) => {
			this.proc = undefined;
			this.initialized = false;
			this.initPromise = undefined;
			this.pending.rejectAll(
				new Error(`LSP server exited (code=${code} signal=${signal}) ${this.stderrTail}`.trim()),
			);
		});
	}

	private handleData(chunk: Buffer): void {
		for (const body of this.framing.push(chunk)) {
			let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };
			try {
				msg = JSON.parse(body) as typeof msg;
			} catch {
				continue;
			}
			if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
				if (msg.error !== undefined) {
					this.pending.reject(
						msg.id,
						new Error(`LSP error: ${JSON.stringify(msg.error).slice(0, 500)}`),
					);
				} else {
					this.pending.resolve(msg.id, msg.result);
				}
				continue;
			}
			if (msg.method === "textDocument/publishDiagnostics") {
				const params = msg.params as { uri?: string; diagnostics?: Diagnostic[] } | undefined;
				if (params?.uri) {
					this.diagnostics.set(params.uri, params.diagnostics ?? []);
					this.options.onDiagnostics?.(params.uri, params.diagnostics ?? []);
				}
			}
		}
	}

	private sendNotification(method: string, params: unknown): void {
		this.start();
		if (!this.stdinWritable()) {
			this.log(`LSP send skipped (stdin not writable): ${method}`);
			return;
		}
		this.proc?.stdin?.write(encodeMessage({ jsonrpc: "2.0", method, params }));
	}

	private sendRequest(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
		this.start();
		if (signal?.aborted) return Promise.reject(new Error("aborted"));
		if (!this.stdinWritable()) return Promise.reject(new Error("LSP server stdin is not writable"));
		const id = this.nextId++;
		const promise = this.pending.add(id);
		this.proc?.stdin?.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
		if (!signal) return promise;
		return new Promise<unknown>((resolve, reject) => {
			const onAbort = () => {
				this.pending.reject(id, new Error("aborted"));
				reject(new Error("aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			promise.then(
				(value) => {
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(err) => {
					signal.removeEventListener("abort", onAbort);
					reject(err);
				},
			);
		});
	}

	/** Queues until initialized; concurrent callers share one handshake. */
	ensureInitialized(): Promise<void> {
		this.start();
		if (this.initialized) return Promise.resolve();
		if (!this.initPromise) {
			this.initPromise = (async () => {
				await this.sendRequest("initialize", {
					processId: process.pid,
					rootUri: this.rootUri,
					rootPath: this.rootPath,
					capabilities: {
						textDocument: {
							hover: { contentFormat: ["markdown", "plaintext"] },
							publishDiagnostics: { relatedInformation: true },
						},
					},
				});
				this.sendNotification("initialized", {});
				this.initialized = true;
			})().catch((err) => {
				this.initPromise = undefined;
				throw err;
			});
		}
		return this.initPromise;
	}

	languageIdFor(filePath: string): string {
		const lower = filePath.toLowerCase();
		if (lower.endsWith(".cs")) return "csharp";
		if (lower.endsWith(".py")) return "python";
		return "typescript";
	}

	async ensureOpen(filePath: string, text: string): Promise<string> {
		await this.ensureInitialized();
		const uri = pathToUri(filePath);
		const existing = this.openFiles.get(uri);
		if (!existing) {
			this.openFiles.set(uri, { version: 1, languageId: this.languageIdFor(filePath), text });
			this.sendNotification("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId: this.languageIdFor(filePath),
					version: 1,
					text,
				},
			});
			return uri;
		}
		if (existing.text !== text) {
			const version = existing.version + 1;
		this.openFiles.set(uri, { version, languageId: this.languageIdFor(filePath), text });
			this.sendNotification("textDocument/didChange", {
				textDocument: { uri, version },
				contentChanges: [{ text }],
			});
		}
		return uri;
	}

	async didChange(filePath: string, text: string): Promise<void> {
		await this.ensureInitialized();
		const uri = pathToUri(filePath);
		const existing = this.openFiles.get(uri);
		const version = (existing?.version ?? 0) + 1;
		this.openFiles.set(uri, { version, languageId: this.languageIdFor(filePath), text });
		this.sendNotification("textDocument/didChange", {
			textDocument: { uri, version },
			contentChanges: [{ text }],
		});
	}

	async didClose(filePath: string): Promise<void> {
		await this.ensureInitialized();
		const uri = pathToUri(filePath);
		this.openFiles.delete(uri);
		this.sendNotification("textDocument/didClose", { textDocument: { uri } });
	}

	hover(uri: string, line: number, character: number, signal?: AbortSignal): Promise<unknown> {
		return this.sendRequest(
			"textDocument/hover",
			{ textDocument: { uri }, position: { line, character } },
			signal,
		);
	}

	definition(uri: string, line: number, character: number, signal?: AbortSignal): Promise<unknown> {
		return this.sendRequest(
			"textDocument/definition",
			{ textDocument: { uri }, position: { line, character } },
			signal,
		);
	}

	references(
		uri: string,
		line: number,
		character: number,
		includeDeclaration = false,
		signal?: AbortSignal,
	): Promise<unknown> {
		return this.sendRequest(
			"textDocument/references",
			{ textDocument: { uri }, position: { line, character }, context: { includeDeclaration } },
			signal,
		);
	}

	documentSymbol(uri: string, signal?: AbortSignal): Promise<unknown> {
		return this.sendRequest("textDocument/documentSymbol", { textDocument: { uri } }, signal);
	}

	workspaceSymbol(query: string, signal?: AbortSignal): Promise<unknown> {
		return this.sendRequest("workspace/symbol", { query }, signal);
	}

	getDiagnostics(uri?: string): Diagnostic[] {
		if (uri) return this.diagnostics.get(uri) ?? [];
		return [...this.diagnostics.values()].flat();
	}

	diagnosticUris(): string[] {
		return [...this.diagnostics.keys()];
	}

	/** Idempotent shutdown: SIGTERM then SIGKILL. */
	async stop(): Promise<void> {
		this.stopped = true;
		this.pending.rejectAll(new Error("LSP client stopped"));
		const proc = this.proc;
		this.proc = undefined;
		this.initialized = false;
		this.initPromise = undefined;
		this.openFiles.clear();
		if (!proc || proc.exitCode !== null) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {
					// already gone
				}
				resolve();
			}, 800);
			if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
				(timer as unknown as { unref: () => void }).unref();
			}
			proc.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			try {
				proc.kill("SIGTERM");
			} catch {
				clearTimeout(timer);
				resolve();
			}
		});
	}
}
