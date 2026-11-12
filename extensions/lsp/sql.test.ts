import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DidOpenTextDocument, FakeLspProcess } from "./client.test.ts";
import type { LspConfig, SupportedLanguage } from "./config.ts";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "typebox") {
			return nextResolve(
				pathToFileURL(
					path.resolve(
						import.meta.dirname,
						"../../install/releases/1.5.2/node_modules/typebox/build/index.mjs",
					),
				).href,
				context,
			);
		}
		if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
			return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
		}
		return nextResolve(specifier, context);
	},
});

const { createFakeLspProcess } = await import("./client.test.ts");
const { uriToPath } = await import("./client.ts");
const {
	DEFAULT_CONFIG,
	INSTALL_HINTS,
	languageFromFile,
	resolveFileLanguageInfo,
	SUPPORTED_LANGUAGES,
} = await import("./config.ts");
const { findRoot, LspManager } = await import("./manager.ts");
const { registerLspTools, resolveLanguage } = await import("./tools.ts");

const spawnedServerProcesses: FakeLspProcess[] = [];
const temporaryFolders: string[] = [];
const managersToStop: Array<InstanceType<typeof LspManager>> = [];
let nextDidOpenHook:
	| ((serverProcess: FakeLspProcess, textDocument: DidOpenTextDocument) => void)
	| undefined;

const spawnFakeServerProcess = (() => {
	const serverProcess = createFakeLspProcess({
		onDidOpen(proc, textDocument) {
			nextDidOpenHook?.(proc, textDocument);
		},
	});
	spawnedServerProcesses.push(serverProcess);
	return serverProcess;
}) as unknown as typeof spawn;

afterEach(async () => {
	nextDidOpenHook = undefined;
	while (managersToStop.length > 0) {
		const manager = managersToStop.pop()!;
		await manager.stopAll();
	}
	while (temporaryFolders.length > 0) {
		const folder = temporaryFolders.pop()!;
		rmSync(folder, { recursive: true, force: true });
	}
	spawnedServerProcesses.length = 0;
});

function createTemporaryWorkspaceFolder(): string {
	return realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-sql-lsp-test-")));
}

function createNestedFile(rootFolder: string, relativeFilePath: string, content = "SELECT 1;\n"): string {
	const fullFilePath = path.join(rootFolder, relativeFilePath);
	mkdirSync(path.dirname(fullFilePath), { recursive: true });
	writeFileSync(fullFilePath, content, "utf8");
	return fullFilePath;
}

function createFreshConfigCopy(): LspConfig {
	return structuredClone(DEFAULT_CONFIG);
}

interface RegisteredToolHandler {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details: Record<string, unknown>;
		structuredContent: unknown;
		isError?: boolean;
	}>;
}

function createToolRegistrationHarness(manager: InstanceType<typeof LspManager>, workspaceFolder: string) {
	const registeredTools = new Map<string, RegisteredToolHandler>();
	const fakeExtensionApi = {
		registerTool(toolDefinition: RegisteredToolHandler) {
			registeredTools.set(toolDefinition.name, toolDefinition);
		},
	} as unknown as ExtensionAPI;

	registerLspTools(fakeExtensionApi, manager, () => workspaceFolder);
	return registeredTools;
}

describe("Recognizing SQL and PostgreSQL files from their file names", () => {
	test("identifies standard SQL file extensions as SQL language files", () => {
		const sqlExtensions = [".sql", ".tsql", ".ddl", ".dml"];

		for (const extension of sqlExtensions) {
			const fileName = `query${extension}`;
			assert.deepEqual(resolveFileLanguageInfo(fileName), {
				language: "sql",
				languageId: "sql",
			});
			assert.equal(languageFromFile(fileName), "sql");
		}
	});

	test("identifies PostgreSQL file extensions as PostgreSQL language files", () => {
		const postgresExtensions = [".pgsql", ".plpgsql", ".psql"];

		for (const extension of postgresExtensions) {
			const fileName = `procedure${extension}`;
			assert.deepEqual(resolveFileLanguageInfo(fileName), {
				language: "postgres",
				languageId: "postgres",
			});
			assert.equal(languageFromFile(fileName), "postgres");
		}
	});

	test("recognizes uppercase and mixed-case SQL and PostgreSQL file extensions", () => {
		const uppercaseAndMixedSqlFiles = ["SCHEMA.SQL", "stored_proc.TSQL", "table.DdL", "seed.DmL"];
		for (const fileName of uppercaseAndMixedSqlFiles) {
			assert.deepEqual(resolveFileLanguageInfo(fileName), {
				language: "sql",
				languageId: "sql",
			});
			assert.equal(languageFromFile(fileName), "sql");
		}

		const uppercaseAndMixedPostgresFiles = ["QUERY.PGSQL", "trigger.PlPgSql", "interactive.PSQL"];
		for (const fileName of uppercaseAndMixedPostgresFiles) {
			assert.deepEqual(resolveFileLanguageInfo(fileName), {
				language: "postgres",
				languageId: "postgres",
			});
			assert.equal(languageFromFile(fileName), "postgres");
		}
	});

	test("recognizes SQL and PostgreSQL files inside nested folders and with multiple dots in the name", () => {
		assert.deepEqual(resolveFileLanguageInfo("migrations/2025.03.01.schema.sql"), {
			language: "sql",
			languageId: "sql",
		});
		assert.equal(languageFromFile("migrations/2025.03.01.schema.sql"), "sql");

		assert.deepEqual(resolveFileLanguageInfo("functions/user.Trigger.plpgsql"), {
			language: "postgres",
			languageId: "postgres",
		});
		assert.equal(languageFromFile("functions/user.Trigger.plpgsql"), "postgres");
	});

	test("returns nothing for unsupported database files or files without an extension", () => {
		const unsupportedFileNames = ["local.sqlite", "data.db", "cassandra.cql", "schema.prisma", "SQL", ""];

		for (const fileName of unsupportedFileNames) {
			assert.equal(resolveFileLanguageInfo(fileName), undefined);
			assert.equal(languageFromFile(fileName), undefined);
		}
	});
});

describe("Default SQL and PostgreSQL language server settings and installation guidance", () => {
	test("lists both sql and postgres among the supported languages", () => {
		assert.ok(SUPPORTED_LANGUAGES.includes("sql"));
		assert.ok(SUPPORTED_LANGUAGES.includes("postgres"));
	});

	test("provides the default command, startup arguments, and project markers for the SQL language server", () => {
		assert.deepEqual(DEFAULT_CONFIG.servers.sql, {
			command: "sql-language-server",
			args: ["up", "--method", "stdio"],
			rootMarkers: [".sqllsrc.json", ".sqlfluff", ".sqruff", "sqls.yml", ".git"],
			enabled: true,
		});
	});

	test("provides the default command, startup arguments, and project markers for the PostgreSQL language server", () => {
		assert.deepEqual(DEFAULT_CONFIG.servers.postgres, {
			command: "postgres-language-server",
			args: ["lsp-proxy"],
			rootMarkers: ["postgres-language-server.jsonc", "postgrestools.jsonc", ".sqllsrc.json", ".sqlfluff", ".git"],
			enabled: true,
		});
	});

	test("includes actionable installation instructions for both SQL and PostgreSQL language servers", () => {
		assert.ok(INSTALL_HINTS.sql.includes("sql-language-server"));
		assert.ok(INSTALL_HINTS.sql.includes("sqls"));
		assert.ok(INSTALL_HINTS.sql.includes("sqruff"));

		assert.ok(INSTALL_HINTS.postgres.includes("@supabase-community/postgres-language-server"));
		assert.ok(INSTALL_HINTS.postgres.includes("lsp-proxy"));
	});
});

describe("Choosing and validating the language when a tool is called on database files", () => {
	test("automatically detects sql or postgres from the file path when no language is specified", () => {
		assert.deepEqual(resolveLanguage(undefined, "/repo/query.sql"), { language: "sql" });
		assert.deepEqual(resolveLanguage(undefined, "/repo/proc.pgsql"), { language: "postgres" });
	});

	test("allows explicitly selecting the postgres server for standard SQL files", () => {
		const sqlFamilyFiles = ["/repo/query.sql", "/repo/proc.tsql", "/repo/schema.ddl", "/repo/seed.dml"];

		for (const filePath of sqlFamilyFiles) {
			assert.deepEqual(resolveLanguage("postgres", filePath), { language: "postgres" });
		}
	});

	test("allows explicitly selecting the sql server for PostgreSQL files", () => {
		const postgresFamilyFiles = ["/repo/query.pgsql", "/repo/fn.plpgsql", "/repo/script.psql"];

		for (const filePath of postgresFamilyFiles) {
			assert.deepEqual(resolveLanguage("sql", filePath), { language: "sql" });
		}
	});

	test("rejects an explicit language that conflicts with a SQL or PostgreSQL file extension", () => {
		const sqlMismatch = resolveLanguage("python", "/repo/query.sql");
		assert.ok("error" in sqlMismatch);
		assert.ok(sqlMismatch.error.includes("Language mismatch: inferred sql but got python"));
		assert.equal(sqlMismatch.inferred, "sql");
		assert.equal(sqlMismatch.explicit, "python");
		assert.equal(sqlMismatch.file, "/repo/query.sql");

		const postgresMismatch = resolveLanguage("csharp", "/repo/fn.plpgsql");
		assert.ok("error" in postgresMismatch);
		assert.ok(postgresMismatch.error.includes("Language mismatch: inferred postgres but got csharp"));
		assert.equal(postgresMismatch.inferred, "postgres");
		assert.equal(postgresMismatch.explicit, "csharp");
		assert.equal(postgresMismatch.file, "/repo/fn.plpgsql");
	});

	test("accepts an explicit sql or postgres language when the file extension is unknown or no file is given", () => {
		assert.deepEqual(resolveLanguage("sql", "/repo/migration.custom"), { language: "sql" });
		assert.deepEqual(resolveLanguage("postgres", "/repo/migration.custom"), { language: "postgres" });
		assert.deepEqual(resolveLanguage("sql", undefined), { language: "sql" });
		assert.deepEqual(resolveLanguage("postgres", undefined), { language: "postgres" });
	});

	test("mentions sql and postgres in the helpful error message when neither file extension nor explicit language is known", () => {
		const unknownFileResult = resolveLanguage(undefined, "/repo/migration.unknown");
		assert.ok("error" in unknownFileResult && unknownFileResult.error.includes("sql|postgres"));

		const missingBothResult = resolveLanguage(undefined, undefined);
		assert.ok("error" in missingBothResult && missingBothResult.error.includes("sql|postgres"));
	});
});

describe("Finding the project root folder for SQL and PostgreSQL workspaces", () => {
	test("locates the SQL project root when any supported SQL configuration marker is present", () => {
		const sqlMarkers = [".sqllsrc.json", ".sqlfluff", ".sqruff", "sqls.yml", ".git"];

		for (const marker of sqlMarkers) {
			const workspaceFolder = createTemporaryWorkspaceFolder();
			temporaryFolders.push(workspaceFolder);
			writeFileSync(path.join(workspaceFolder, marker), "", "utf8");
			const nestedSqlFile = createNestedFile(workspaceFolder, "db/migrations/001_init.sql");

			const manager = new LspManager(createFreshConfigCopy());
			assert.equal(findRoot(nestedSqlFile, DEFAULT_CONFIG.servers.sql.rootMarkers), workspaceFolder);
			assert.equal(manager.rootFor("sql", nestedSqlFile), workspaceFolder);
		}
	});

	test("locates the PostgreSQL project root using postgres markers while keeping SQL root search independent when servers differ", () => {
		const postgresMarkers = ["postgres-language-server.jsonc", "postgrestools.jsonc"];

		for (const marker of postgresMarkers) {
			const workspaceFolder = createTemporaryWorkspaceFolder();
			temporaryFolders.push(workspaceFolder);
			writeFileSync(path.join(workspaceFolder, marker), "{}", "utf8");
			const nestedSqlFile = createNestedFile(workspaceFolder, "supabase/migrations/20250101_users.sql");

			const manager = new LspManager(createFreshConfigCopy());
			assert.equal(manager.rootFor("postgres", nestedSqlFile), workspaceFolder);
			assert.equal(manager.rootFor("sql", nestedSqlFile), path.dirname(nestedSqlFile));
		}
	});

	test("falls back to the file's immediate folder when no project root markers exist", () => {
		const workspaceFolder = createTemporaryWorkspaceFolder();
		temporaryFolders.push(workspaceFolder);
		const nestedSqlFile = createNestedFile(workspaceFolder, "isolated/queries/report.sql");
		const expectedImmediateFolder = path.dirname(nestedSqlFile);

		const manager = new LspManager(createFreshConfigCopy());
		assert.equal(manager.rootFor("sql", nestedSqlFile), expectedImmediateFolder);
		assert.equal(manager.rootFor("postgres", nestedSqlFile), expectedImmediateFolder);
	});
});

describe("Managing separate or shared SQL and PostgreSQL language server instances", () => {
	test("runs separate SQL and PostgreSQL server instances when using the default configuration", async () => {
		const workspaceFolder = createTemporaryWorkspaceFolder();
		temporaryFolders.push(workspaceFolder);
		writeFileSync(path.join(workspaceFolder, ".git"), "", "utf8");
		const sqlFile = createNestedFile(workspaceFolder, "queries/users.sql", "SELECT * FROM users;\n");
		const postgresFile = createNestedFile(workspaceFolder, "queries/notify.pgsql", "SELECT pg_notify('ch', 'hi');\n");

		const manager = new LspManager(createFreshConfigCopy(), async () => true, spawnFakeServerProcess);
		managersToStop.push(manager);

		const sqlSession = await manager.ensure("sql", sqlFile);
		const postgresSession = await manager.ensure("postgres", postgresFile);

		assert.notEqual(sqlSession.client, postgresSession.client);
		const runningStatuses = manager.status();
		assert.equal(runningStatuses.length, 2);
		assert.deepEqual(runningStatuses, [
			{
				language: "sql",
				root: workspaceFolder,
				running: true,
				openFiles: 1,
				diagnosticUris: 0,
			},
			{
				language: "postgres",
				root: workspaceFolder,
				running: true,
				openFiles: 1,
				diagnosticUris: 0,
			},
		]);
	});

	test("shares a single server instance when sql and postgres are configured with the exact same command and arguments", async () => {
		const workspaceFolder = createTemporaryWorkspaceFolder();
		temporaryFolders.push(workspaceFolder);
		writeFileSync(path.join(workspaceFolder, ".git"), "", "utf8");
		const sqlFile = createNestedFile(workspaceFolder, "queries/orders.sql", "SELECT * FROM orders;\n");
		const postgresFile = createNestedFile(workspaceFolder, "queries/func.plpgsql", "SELECT 1;\n");

		const sharedServerConfig = createFreshConfigCopy();
		sharedServerConfig.servers.sql = {
			command: "sqruff",
			args: ["lsp"],
			rootMarkers: [".sqruff", ".git"],
			enabled: true,
		};
		sharedServerConfig.servers.postgres = {
			command: "sqruff",
			args: ["lsp"],
			rootMarkers: ["postgres-language-server.jsonc", ".git"],
			enabled: true,
		};

		const manager = new LspManager(sharedServerConfig, async () => true, spawnFakeServerProcess);
		managersToStop.push(manager);

		const firstSession = await manager.ensure("sql", sqlFile);
		const secondSession = await manager.ensure("postgres", postgresFile);

		assert.equal(firstSession.client, secondSession.client);
		assert.deepEqual(manager.status(), [
			{
				language: "sql",
				root: workspaceFolder,
				running: true,
				openFiles: 2,
				diagnosticUris: 0,
			},
		]);
	});

	test("keeps sql and postgres server instances separate when the command matches but startup arguments differ", async () => {
		const workspaceFolder = createTemporaryWorkspaceFolder();
		temporaryFolders.push(workspaceFolder);
		writeFileSync(path.join(workspaceFolder, ".git"), "", "utf8");
		const sqlFile = createNestedFile(workspaceFolder, "queries/one.sql", "SELECT 1;\n");
		const postgresFile = createNestedFile(workspaceFolder, "queries/two.pgsql", "SELECT 2;\n");

		const differentArgsConfig = createFreshConfigCopy();
		differentArgsConfig.servers.sql = {
			command: "sqls",
			args: ["-config", "mysql.yml"],
			rootMarkers: [".git"],
			enabled: true,
		};
		differentArgsConfig.servers.postgres = {
			command: "sqls",
			args: ["-config", "postgres.yml"],
			rootMarkers: [".git"],
			enabled: true,
		};

		const manager = new LspManager(differentArgsConfig, async () => true, spawnFakeServerProcess);
		managersToStop.push(manager);

		const sqlSession = await manager.ensure("sql", sqlFile);
		const postgresSession = await manager.ensure("postgres", postgresFile);

		assert.notEqual(sqlSession.client, postgresSession.client);
		assert.equal(manager.status().length, 2);
	});

	test("refuses to start when the server is disabled or its executable is missing and shows installation hints", async () => {
		const workspaceFolder = createTemporaryWorkspaceFolder();
		temporaryFolders.push(workspaceFolder);
		const sqlFile = createNestedFile(workspaceFolder, "queries/check.sql", "SELECT 1;\n");

		const disabledPostgresConfig = createFreshConfigCopy();
		disabledPostgresConfig.servers.postgres.enabled = false;
		const disabledManager = new LspManager(disabledPostgresConfig, async () => true, spawnFakeServerProcess);
		managersToStop.push(disabledManager);

		await assert.rejects(
			disabledManager.ensure("postgres", sqlFile),
			(err: unknown) =>
				err instanceof Error &&
				err.message.includes("LSP for postgres is disabled in lsp.json (servers.postgres.enabled=false)."),
		);

		const missingBinaryManager = new LspManager(createFreshConfigCopy(), async () => false, spawnFakeServerProcess);
		managersToStop.push(missingBinaryManager);

		await assert.rejects(
			missingBinaryManager.ensure("postgres", sqlFile),
			(err: unknown) => err instanceof Error && err.message.includes(INSTALL_HINTS.postgres),
		);
		await assert.rejects(
			missingBinaryManager.ensure("sql", sqlFile),
			(err: unknown) => err instanceof Error && err.message.includes(INSTALL_HINTS.sql),
		);
	});
});

describe("End-to-end tool execution for SQL and PostgreSQL files", () => {
	test("opens a .sql file with the explicit postgres server via lsp_diagnostics, sends languageId sql, and returns 1-based diagnostics", async () => {
		const workspaceFolder = createTemporaryWorkspaceFolder();
		temporaryFolders.push(workspaceFolder);
		writeFileSync(path.join(workspaceFolder, "postgres-language-server.jsonc"), "{}", "utf8");
		const sqlFile = createNestedFile(workspaceFolder, "migrations/001_broken.sql", "SELEC * FORM users;\n");

		const manager = new LspManager(createFreshConfigCopy(), async () => true, spawnFakeServerProcess);
		managersToStop.push(manager);
		const registeredTools = createToolRegistrationHarness(manager, workspaceFolder);
		const diagnosticsTool = registeredTools.get("lsp_diagnostics");
		assert.notEqual(diagnosticsTool, undefined);

		let openedDocumentDetails: DidOpenTextDocument | undefined;
		nextDidOpenHook = (serverProcess, textDocument) => {
			openedDocumentDetails = textDocument;
			serverProcess.emitPublishDiagnostics({
				uri: textDocument.uri,
				diagnostics: [
					{
						uri: textDocument.uri,
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 5 },
						},
						severity: 1,
						message: 'syntax error at or near "SELEC"',
						source: "postgres-language-server",
					},
				],
			});
		};

		const response = await diagnosticsTool!.execute("call-diag-1", {
			language: "postgres" as SupportedLanguage,
			file: sqlFile,
		});

		assert.notEqual(openedDocumentDetails, undefined);
		assert.equal(openedDocumentDetails?.languageId, "sql");
		assert.equal(response.isError, undefined);
		assert.equal(response.details.tool, "lsp_diagnostics");
		assert.equal(response.details.count, 1);
		const expectedUri = openedDocumentDetails!.uri;
		assert.deepEqual(response.structuredContent, {
			diagnostics: [
				{
					uri: expectedUri,
					path: uriToPath(expectedUri),
					line: 1,
					character: 1,
					message: 'syntax error at or near "SELEC"',
					severity: 1,
				},
			],
		});
		assert.deepEqual(manager.status(), [
			{
				language: "postgres",
				root: workspaceFolder,
				running: true,
				openFiles: 1,
				diagnosticUris: 1,
			},
		]);
	});

	test("rejects a mismatched python language request on a .sql file in lsp_hover with structured error details", async () => {
		const workspaceFolder = createTemporaryWorkspaceFolder();
		temporaryFolders.push(workspaceFolder);
		const sqlFile = createNestedFile(workspaceFolder, "queries/active_users.sql", "SELECT id FROM users;\n");

		const manager = new LspManager(createFreshConfigCopy(), async () => true, spawnFakeServerProcess);
		managersToStop.push(manager);
		const registeredTools = createToolRegistrationHarness(manager, workspaceFolder);
		const hoverTool = registeredTools.get("lsp_hover");
		assert.notEqual(hoverTool, undefined);

		const response = await hoverTool!.execute("call-hover-1", {
			language: "python" as SupportedLanguage,
			file: sqlFile,
			line: 1,
			character: 1,
		});

		assert.equal(response.isError, true);
		assert.equal(response.details.tool, "lsp_hover");
		assert.equal(response.details.inferred, "sql");
		assert.equal(response.details.explicit, "python");
		assert.ok(String(response.details.error).includes("Language mismatch: inferred sql but got python"));
		assert.equal(spawnedServerProcesses.length, 0);
	});
});
