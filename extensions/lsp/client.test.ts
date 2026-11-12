import { afterEach, describe, expect, mock, test } from "bun:test";
import * as realChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as os from "node:os";
import * as path from "node:path";
import { encodeMessage, LspFraming } from "./protocol.ts";

interface RpcMessage {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: unknown;
}

interface FakeLspProcess extends EventEmitter {
	stdin: EventEmitter & {
		writable: boolean;
		write: (chunk: Buffer | string) => boolean;
	};
	stdout: EventEmitter;
	stderr: EventEmitter;
	exitCode: number | null;
	kill: (signal?: string) => boolean;
	sentMessages: RpcMessage[];
	emitPublishDiagnostics: (params: unknown) => void;
}

let activeProc: FakeLspProcess | null = null;

function createFakeLspProcess(): FakeLspProcess {
	const proc = new EventEmitter() as FakeLspProcess;
	const stdinEmitter = new EventEmitter() as FakeLspProcess["stdin"];
	const inboundFraming = new LspFraming();
	proc.sentMessages = [];
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.exitCode = null;

	stdinEmitter.writable = true;
	stdinEmitter.write = (chunk: Buffer | string) => {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
		for (const rawBody of inboundFraming.push(buf)) {
			const msg = JSON.parse(rawBody) as RpcMessage;
			proc.sentMessages.push(msg);
			if (msg.method === "initialize" && msg.id !== undefined) {
				queueMicrotask(() => {
					proc.stdout.emit(
						"data",
						encodeMessage({
							jsonrpc: "2.0",
							id: msg.id,
							result: { capabilities: {} },
						}),
					);
				});
			}
		}
		return true;
	};
	proc.stdin = stdinEmitter;

	proc.kill = () => {
		proc.exitCode = 0;
		queueMicrotask(() => proc.emit("exit", 0, null));
		return true;
	};

	proc.emitPublishDiagnostics = (params: unknown) => {
		proc.stdout.emit(
			"data",
			encodeMessage({
				jsonrpc: "2.0",
				method: "textDocument/publishDiagnostics",
				params,
			}),
		);
	};

	return proc;
}

const spawnMock = mock(() => {
	const proc = createFakeLspProcess();
	activeProc = proc;
	return proc;
});

mock.module("node:child_process", () => ({
	...realChildProcess,
	spawn: spawnMock,
}));

const { LspClient, pathToUri } = await import("./client.ts");
type Diagnostic = import("./client.ts").Diagnostic;

const rootPath = path.join(os.tmpdir(), "pi-lsp-client-test");
const rootUri = pathToUri(rootPath);

function createTestClient(onDiagnostics?: (uri: string, diagnostics: Diagnostic[]) => void) {
	return new LspClient({
		command: "fake-lsp-server",
		args: ["--stdio"],
		rootPath,
		rootUri,
		onDiagnostics,
	});
}

function makeSampleDiagnostic(uri: string, message: string): Diagnostic {
	return {
		uri,
		range: {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 5 },
		},
		severity: 1,
		message,
		source: "typescript",
	};
}

describe("LspClient diagnostic cache and sequence tracking", () => {
	let clientToStop: InstanceType<typeof LspClient> | null = null;

	afterEach(async () => {
		if (clientToStop) {
			await clientToStop.stop();
			clientToStop = null;
		}
		activeProc = null;
	});

	test("reports hasDiagnostics as false before any publishDiagnostics notification arrives", async () => {
		const client = createTestClient();
		clientToStop = client;
		const filePath = path.join(rootPath, "unreported.ts");
		const expectedUri = pathToUri(filePath);

		expect(client.hasDiagnostics(expectedUri)).toBe(false);

		const openedUri = await client.ensureOpen(filePath, "const x = 1;\n");
		expect(openedUri).toBe(expectedUri);
		expect(client.hasDiagnostics(openedUri)).toBe(false);
		expect(client.getDiagnostics(openedUri)).toEqual([]);
	});

	test("marks hasDiagnostics as true when publishDiagnostics arrives with an empty diagnostics list", async () => {
		const client = createTestClient();
		clientToStop = client;
		const filePath = path.join(rootPath, "clean.ts");
		const uri = await client.ensureOpen(filePath, "export const clean = true;\n");

		activeProc!.emitPublishDiagnostics({ uri, diagnostics: [] });

		expect(client.hasDiagnostics(uri)).toBe(true);
		expect(client.getDiagnostics(uri)).toEqual([]);
	});

	test("stores diagnostics and marks hasDiagnostics as true when publishDiagnostics arrives with errors", async () => {
		const receivedNotifications: Array<{ uri: string; diagnostics: Diagnostic[] }> = [];
		const client = createTestClient((uri, diagnostics) => {
			receivedNotifications.push({ uri, diagnostics });
		});
		clientToStop = client;
		const filePath = path.join(rootPath, "broken.ts");
		const uri = await client.ensureOpen(filePath, "const broken: number = 'wrong';\n");
		const errorDiag = makeSampleDiagnostic(uri, "Type 'string' is not assignable to type 'number'.");

		activeProc!.emitPublishDiagnostics({ uri, diagnostics: [errorDiag] });

		expect(client.hasDiagnostics(uri)).toBe(true);
		expect(client.getDiagnostics(uri)).toEqual([errorDiag]);
		expect(client.getDiagnostics()).toEqual([errorDiag]);
		expect(client.diagnosticUris()).toEqual([uri]);
		expect(receivedNotifications).toEqual([{ uri, diagnostics: [errorDiag] }]);
	});

	test("clears cached diagnostics and resets hasDiagnostics to false when ensureOpen detects modified file text", async () => {
		const client = createTestClient();
		clientToStop = client;
		const filePath = path.join(rootPath, "editable.ts");
		const uri = await client.ensureOpen(filePath, "const v = 1;\n");
		const diag = makeSampleDiagnostic(uri, "Unused variable 'v'.");

		activeProc!.emitPublishDiagnostics({ uri, diagnostics: [diag] });
		expect(client.hasDiagnostics(uri)).toBe(true);
		expect(client.getDiagnostics(uri)).toEqual([diag]);

		await client.ensureOpen(filePath, "export const v = 2;\n");

		expect(client.hasDiagnostics(uri)).toBe(false);
		expect(client.getDiagnostics(uri)).toEqual([]);
		const didChangeMessages = activeProc!.sentMessages.filter((m) => m.method === "textDocument/didChange");
		expect(didChangeMessages.length).toBe(1);
	});

	test("preserves cached diagnostics and hasDiagnostics when ensureOpen is called with unchanged file text", async () => {
		const client = createTestClient();
		clientToStop = client;
		const filePath = path.join(rootPath, "unchanged.ts");
		const initialText = "const same = 42;\n";
		const uri = await client.ensureOpen(filePath, initialText);
		const diag = makeSampleDiagnostic(uri, "Unused variable 'same'.");

		activeProc!.emitPublishDiagnostics({ uri, diagnostics: [diag] });
		expect(client.hasDiagnostics(uri)).toBe(true);

		await client.ensureOpen(filePath, initialText);

		expect(client.hasDiagnostics(uri)).toBe(true);
		expect(client.getDiagnostics(uri)).toEqual([diag]);
		const didChangeMessages = activeProc!.sentMessages.filter((m) => m.method === "textDocument/didChange");
		expect(didChangeMessages.length).toBe(0);
	});

	test("clears cached diagnostics and resets hasDiagnostics to false on explicit didChange", async () => {
		const client = createTestClient();
		clientToStop = client;
		const filePath = path.join(rootPath, "changed.ts");
		const uri = await client.ensureOpen(filePath, "let count = 0;\n");
		const diag = makeSampleDiagnostic(uri, "Prefer const.");

		activeProc!.emitPublishDiagnostics({ uri, diagnostics: [diag] });
		expect(client.hasDiagnostics(uri)).toBe(true);
		expect(client.getDiagnostics(uri)).toEqual([diag]);

		await client.didChange(filePath, "const count = 0;\n");

		expect(client.hasDiagnostics(uri)).toBe(false);
		expect(client.getDiagnostics(uri)).toEqual([]);
	});

	test("removes cached diagnostics, resets hasDiagnostics, and decrements openFileCount on didClose", async () => {
		const client = createTestClient();
		clientToStop = client;
		const filePath = path.join(rootPath, "closing.ts");
		const uri = await client.ensureOpen(filePath, "const temp = true;\n");
		const diag = makeSampleDiagnostic(uri, "Unused temp.");

		activeProc!.emitPublishDiagnostics({ uri, diagnostics: [diag] });
		expect(client.openFileCount()).toBe(1);
		expect(client.hasDiagnostics(uri)).toBe(true);

		await client.didClose(filePath);

		expect(client.openFileCount()).toBe(0);
		expect(client.hasDiagnostics(uri)).toBe(false);
		expect(client.getDiagnostics(uri)).toEqual([]);
		expect(client.diagnosticUris()).toEqual([]);
	});

	test("isolates diagnostic clearing per file URI so editing one file does not clear another file's diagnostics", async () => {
		const client = createTestClient();
		clientToStop = client;
		const firstPath = path.join(rootPath, "first.ts");
		const secondPath = path.join(rootPath, "second.ts");
		const firstUri = await client.ensureOpen(firstPath, "const a = 1;\n");
		const secondUri = await client.ensureOpen(secondPath, "const b = 2;\n");
		const firstDiag = makeSampleDiagnostic(firstUri, "Error in first file.");
		const secondDiag = makeSampleDiagnostic(secondUri, "Error in second file.");

		activeProc!.emitPublishDiagnostics({ uri: firstUri, diagnostics: [firstDiag] });
		activeProc!.emitPublishDiagnostics({ uri: secondUri, diagnostics: [secondDiag] });
		expect(client.hasDiagnostics(firstUri)).toBe(true);
		expect(client.hasDiagnostics(secondUri)).toBe(true);

		await client.ensureOpen(firstPath, "export const a = 10;\n");

		expect(client.hasDiagnostics(firstUri)).toBe(false);
		expect(client.getDiagnostics(firstUri)).toEqual([]);
		expect(client.hasDiagnostics(secondUri)).toBe(true);
		expect(client.getDiagnostics(secondUri)).toEqual([secondDiag]);
	});

	test("ignores publishDiagnostics notifications that are missing a uri field", async () => {
		const receivedNotifications: Array<{ uri: string; diagnostics: Diagnostic[] }> = [];
		const client = createTestClient((uri, diagnostics) => {
			receivedNotifications.push({ uri, diagnostics });
		});
		clientToStop = client;
		const filePath = path.join(rootPath, "valid.ts");
		await client.ensureOpen(filePath, "export const valid = 1;\n");

		activeProc!.emitPublishDiagnostics({ diagnostics: [] });
		activeProc!.emitPublishDiagnostics(undefined);

		expect(client.diagnosticUris()).toEqual([]);
		expect(client.getDiagnostics()).toEqual([]);
		expect(receivedNotifications).toEqual([]);
	});
});
