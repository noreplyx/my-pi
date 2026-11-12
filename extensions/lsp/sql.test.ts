import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DidOpenTextDocument, FakeLspProcess, RpcMessage } from "./client.test.ts";
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
const { pathToUri, uriToPath } = await import("./client.ts");
const { encodeMessage } = await import("./protocol.ts");
const {
	CANONICAL_LANGUAGE_PAIR,
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
let nextRequestResponder:
	| ((serverProcess: FakeLspProcess, message: RpcMessage) => unknown)
	| undefined;

const spawnFakeServerProcess = (() => {
	const serverProcess = createFakeLspProcess({
		onDidOpen(proc, textDocument) {
			nextDidOpenHook?.(proc, textDocument);
		},
	});
	const originalWrite = serverProcess.stdin.write.bind(serverProcess.stdin);
	let handledMessageCount = 0;
	serverProcess.stdin.write = (chunk: Buffer | string) => {
		const writeOutcome = originalWrite(chunk);
		while (handledMessageCount < serverProcess.sentMessages.length) {
			const message = serverProcess.sentMessages[handledMessageCount++]!;
			if (
				message.id !== undefined &&
				message.method !== undefined &&
				message.method !== "initialize" &&
				nextRequestResponder
			) {
				const result = nextRequestResponder(serverProcess, message);
				if (result !== undefined) {
					queueMicrotask(() => {
						serverProcess.stdout.emit(
							"data",
							encodeMessage({
								jsonrpc: "2.0",
								id: message.id,
								result,
							}),
						);
					});
				}
			}
		}
		return writeOutcome;
	};
	spawnedServerProcesses.push(serverProcess);
	return serverProcess;
}) as unknown as typeof spawn;

afterEach(async () => {
	nextDidOpenHook = undefined;
	nextRequestResponder = undefined;
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

describe("Recognizing SQL, SQL Server (T-SQL), and PostgreSQL files from their file names", () => {
	test("identifies standard SQL file extensions as SQL language files and T-SQL file extensions as SQL Server language files", () => {
		const sqlExtensions = [".sql", ".ddl", ".dml"];

		for (const extension of sqlExtensions) {
			const fileName = `query${extension}`;
			assert.deepEqual(resolveFileLanguageInfo(fileName), {
				language: "sql",
				languageId: "sql",
			});
			assert.equal(languageFromFile(fileName), "sql");
		}

		assert.deepEqual(resolveFileLanguageInfo("query.tsql"), {
			language: "sqlserver",
			languageId: "tsql",
		});
		assert.equal(languageFromFile("query.tsql"), "sqlserver");
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

	test("recognizes uppercase and mixed-case SQL, SQL Server, and PostgreSQL file extensions", () => {
		const uppercaseAndMixedSqlFiles = ["SCHEMA.SQL", "table.DdL", "seed.DmL"];
		for (const fileName of uppercaseAndMixedSqlFiles) {
			assert.deepEqual(resolveFileLanguageInfo(fileName), {
				language: "sql",
				languageId: "sql",
			});
			assert.equal(languageFromFile(fileName), "sql");
		}

		const uppercaseAndMixedSqlServerFiles = ["stored_proc.TSQL", "usp_GetOrders.TsQl"];
		for (const fileName of uppercaseAndMixedSqlServerFiles) {
			assert.deepEqual(resolveFileLanguageInfo(fileName), {
				language: "sqlserver",
				languageId: "tsql",
			});
			assert.equal(languageFromFile(fileName), "sqlserver");
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

	test("recognizes SQL, SQL Server, and PostgreSQL files inside nested folders and with multiple dots in the name", () => {
		assert.deepEqual(resolveFileLanguageInfo("migrations/2025.03.01.schema.sql"), {
			language: "sql",
			languageId: "sql",
		});
		assert.equal(languageFromFile("migrations/2025.03.01.schema.sql"), "sql");

		assert.deepEqual(resolveFileLanguageInfo("programmability/procs/dbo.usp_GetOrders.v2.tsql"), {
			language: "sqlserver",
			languageId: "tsql",
		});
		assert.equal(languageFromFile("programmability/procs/dbo.usp_GetOrders.v2.tsql"), "sqlserver");

		assert.deepEqual(resolveFileLanguageInfo("functions/user.Trigger.plpgsql"), {
			language: "postgres",
			languageId: "postgres",
		});
		assert.equal(languageFromFile("functions/user.Trigger.plpgsql"), "postgres");
	});

	test("returns nothing for unsupported database files or files without an extension", () => {
		const unsupportedFileNames = [
			"local.sqlite",
			"data.db",
			"cassandra.cql",
			"schema.prisma",
			"package.dacpac",
			"TSQL",
			"SQL",
			"",
		];

		for (const fileName of unsupportedFileNames) {
			assert.equal(resolveFileLanguageInfo(fileName), undefined);
			assert.equal(languageFromFile(fileName), undefined);
		}
	});
});

describe("Default SQL, SQL Server, and PostgreSQL language server settings and installation guidance", () => {
	test("lists sql, postgres, and sqlserver among the supported languages and maps sqlserver and postgres to the canonical sql pair", () => {
		assert.ok(SUPPORTED_LANGUAGES.includes("sql"));
		assert.ok(SUPPORTED_LANGUAGES.includes("postgres"));
		assert.ok(SUPPORTED_LANGUAGES.includes("sqlserver"));
		assert.equal(CANONICAL_LANGUAGE_PAIR.sqlserver, "sql");
		assert.equal(CANONICAL_LANGUAGE_PAIR.postgres, "sql");
	});

	test("provides the default command, startup arguments, and project markers for the SQL language server", () => {
		assert.deepEqual(DEFAULT_CONFIG.servers.sql, {
			command: "sql-language-server",
			args: ["up", "--method", "stdio"],
			rootMarkers: [".sqllsrc.json", "sqls.yml", ".sqlfluff", ".sqruff", "*.sqlproj", ".git"],
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

	test("provides the default command, startup arguments, and project markers including *.sqlproj for the SQL Server language server", () => {
		assert.deepEqual(DEFAULT_CONFIG.servers.sqlserver, {
			command: "sql-language-server",
			args: ["up", "--method", "stdio"],
			rootMarkers: [".sqllsrc.json", "sqls.yml", ".sqlfluff", ".sqruff", "*.sqlproj", ".git"],
			enabled: true,
		});
	});

	test("includes actionable installation instructions for SQL, PostgreSQL, and SQL Server language servers", () => {
		assert.ok(INSTALL_HINTS.sql.includes("sql-language-server"));
		assert.ok(INSTALL_HINTS.sql.includes("sqls"));
		assert.ok(INSTALL_HINTS.sql.includes("sqruff"));

		assert.ok(INSTALL_HINTS.postgres.includes("@supabase-community/postgres-language-server"));
		assert.ok(INSTALL_HINTS.postgres.includes("lsp-proxy"));

		assert.ok(INSTALL_HINTS.sqlserver.includes("sql-language-server"));
		assert.ok(INSTALL_HINTS.sqlserver.includes("mssql"));
		assert.ok(INSTALL_HINTS.sqlserver.includes("sqls"));
		assert.ok(INSTALL_HINTS.sqlserver.includes("sqruff"));
		assert.ok(INSTALL_HINTS.sqlserver.includes("tsql"));
	});
});

describe("Choosing and validating the language when a tool is called on database files", () => {
	test("automatically detects sql, sqlserver, or postgres from the file path when no language is specified", () => {
		assert.deepEqual(resolveLanguage(undefined, "/repo/query.sql"), { language: "sql" });
		assert.deepEqual(resolveLanguage(undefined, "/repo/proc.tsql"), { language: "sqlserver" });
		assert.deepEqual(resolveLanguage(undefined, "/repo/proc.pgsql"), { language: "postgres" });
	});

	test("allows explicitly selecting the postgres or sqlserver server for standard SQL files", () => {
		const standardSqlFiles = ["/repo/query.sql", "/repo/schema.ddl", "/repo/seed.dml"];

		for (const filePath of standardSqlFiles) {
			assert.deepEqual(resolveLanguage("postgres", filePath), { language: "postgres" });
			assert.deepEqual(resolveLanguage("sqlserver", filePath), { language: "sqlserver" });
		}
	});

	test("allows explicitly selecting sqlserver on .sql, .ddl, .dml, and .tsql files and allows sql on .tsql files", () => {
		assert.deepEqual(resolveLanguage("sqlserver", "/repo/query.sql"), { language: "sqlserver" });
		assert.deepEqual(resolveLanguage("sqlserver", "/repo/schema.ddl"), { language: "sqlserver" });
		assert.deepEqual(resolveLanguage("sqlserver", "/repo/seed.dml"), { language: "sqlserver" });
		assert.deepEqual(resolveLanguage("sqlserver", "/repo/proc.tsql"), { language: "sqlserver" });
		assert.deepEqual(resolveLanguage("sql", "/repo/proc.tsql"), { language: "sql" });
	});

	test("allows explicitly selecting the sql server for PostgreSQL files", () => {
		const postgresFamilyFiles = ["/repo/query.pgsql", "/repo/fn.plpgsql", "/repo/script.psql"];

		for (const filePath of postgresFamilyFiles) {
			assert.deepEqual(resolveLanguage("sql", filePath), { language: "sql" });
		}
	});

	test("rejects cross-dialect language requests between sqlserver and postgres with a Language mismatch error", () => {
		const postgresFiles = ["/repo/query.pgsql", "/repo/fn.plpgsql", "/repo/script.psql"];
		for (const filePath of postgresFiles) {
			const result = resolveLanguage("sqlserver", filePath);
			assert.ok("error" in result);
			assert.equal(
				result.error,
				`Language mismatch: inferred postgres but got sqlserver for file ${filePath}; pass matching language or omit language to use inference.`,
			);
			assert.equal(result.inferred, "postgres");
			assert.equal(result.explicit, "sqlserver");
			assert.equal(result.file, filePath);
		}

		const postgresOnTsql = resolveLanguage("postgres", "/repo/proc.tsql");
		assert.deepEqual(postgresOnTsql, {
			error:
				"Language mismatch: inferred sqlserver but got postgres for file /repo/proc.tsql; pass matching language or omit language to use inference.",
			inferred: "sqlserver",
			explicit: "postgres",
			file: "/repo/proc.tsql",
		});

		const csharpOnTsql = resolveLanguage("csharp", "/repo/proc.tsql");
		assert.ok("error" in csharpOnTsql);
		assert.ok(csharpOnTsql.error.includes("Language mismatch: inferred sqlserver but got csharp"));
		assert.equal(csharpOnTsql.inferred, "sqlserver");
		assert.equal(csharpOnTsql.explicit, "csharp");
		assert.equal(csharpOnTsql.file, "/repo/proc.tsql");
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

	test("accepts an explicit sqlserver language when the file extension is unknown or no file is given and lists sqlserver in unknown-file errors", () => {
		assert.deepEqual(resolveLanguage("sql", "/repo/migration.custom"), { language: "sql" });
		assert.deepEqual(resolveLanguage("postgres", "/repo/migration.custom"), { language: "postgres" });
		assert.deepEqual(resolveLanguage("sqlserver", "/repo/migration.custom"), { language: "sqlserver" });
		assert.deepEqual(resolveLanguage("sql", undefined), { language: "sql" });
		assert.deepEqual(resolveLanguage("postgres", undefined), { language: "postgres" });
		assert.deepEqual(resolveLanguage("sqlserver", undefined), { language: "sqlserver" });

		const unknownFileResult = resolveLanguage(undefined, "/repo/migration.unknown");
		assert.ok("error" in unknownFileResult && unknownFileResult.error.includes("sql|postgres|sqlserver"));

		const missingBothResult = resolveLanguage(undefined, undefined);
		assert.ok("error" in missingBothResult && missingBothResult.error.includes("sql|postgres|sqlserver"));
	});
});

describe("Finding the project root folder for SQL, SQL Server, and PostgreSQL workspaces", () => {
	test("locates the SQL project root when any supported SQL configuration marker is present", () => {
		const sqlMarkers = [".sqllsrc.json", "sqls.yml", ".sqlfluff", ".sqruff", "Database.sqlproj", ".git"];

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

	test("locates the SQL Server project root using *.sqlproj or standard SQL markers under default canonicalization", () => {
		const sqlServerMarkerFiles = [
			"EnterpriseDb.sqlproj",
			".sqllsrc.json",
			"sqls.yml",
			".sqlfluff",
			".sqruff",
			".git",
		];

		for (const markerFile of sqlServerMarkerFiles) {
			const workspaceFolder = createTemporaryWorkspaceFolder();
			temporaryFolders.push(workspaceFolder);
			writeFileSync(path.join(workspaceFolder, markerFile), "", "utf8");
			const nestedTsqlFile = createNestedFile(
				workspaceFolder,
				"dbo/StoredProcedures/usp_Orders.tsql",
				"CREATE PROCEDURE dbo.usp_Orders AS SELECT 1;\n",
			);

			const manager = new LspManager(createFreshConfigCopy());
			assert.equal(findRoot(nestedTsqlFile, DEFAULT_CONFIG.servers.sqlserver.rootMarkers), workspaceFolder);
			assert.equal(manager.rootFor("sqlserver", nestedTsqlFile), workspaceFolder);
		}
	});

	test("locates the SQL Server project root using *.sqlproj when sqlserver has a custom server command or args", () => {
		const workspaceFolder = createTemporaryWorkspaceFolder();
		temporaryFolders.push(workspaceFolder);
		writeFileSync(path.join(workspaceFolder, "EnterpriseDb.sqlproj"), "<Project />", "utf8");
		writeFileSync(path.join(workspaceFolder, "mssql-custom.json"), "{}", "utf8");
		const nestedTsqlFile = createNestedFile(
			workspaceFolder,
			"dbo/StoredProcedures/usp_Orders.tsql",
			"CREATE PROCEDURE dbo.usp_Orders AS SELECT 1;\n",
		);

		const customSqlServerConfig = createFreshConfigCopy();
		customSqlServerConfig.servers.sql.rootMarkers = [".sqllsrc.json"];
		customSqlServerConfig.servers.sqlserver = {
			command: "sqls",
			args: ["-config", "mssql.yml"],
			rootMarkers: ["*.sqlproj", "mssql-custom.json"],
			enabled: true,
		};

		const manager = new LspManager(customSqlServerConfig);
		assert.equal(manager.rootFor("sqlserver", nestedTsqlFile), workspaceFolder);
		assert.equal(manager.rootFor("sql", nestedTsqlFile), path.dirname(nestedTsqlFile));
	});

	test("merges sqlserver and sql root markers when command and args match so custom sqlserver markers are still honored", () => {
		const workspaceFolder = createTemporaryWorkspaceFolder();
		temporaryFolders.push(workspaceFolder);
		writeFileSync(path.join(workspaceFolder, "mssql-project.json"), "{}", "utf8");
		const nestedTsqlFile = createNestedFile(
			workspaceFolder,
			"dbo/StoredProcedures/usp_Orders.tsql",
			"CREATE PROCEDURE dbo.usp_Orders AS SELECT 1;\n",
		);

		const configWithCustomSqlServerMarker = createFreshConfigCopy();
		configWithCustomSqlServerMarker.servers.sqlserver.rootMarkers = ["mssql-project.json"];

		const manager = new LspManager(configWithCustomSqlServerMarker);
		assert.equal(manager.rootFor("sqlserver", nestedTsqlFile), workspaceFolder);
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
		assert.equal(manager.rootFor("sqlserver", nestedSqlFile), expectedImmediateFolder);
		assert.equal(manager.rootFor("postgres", nestedSqlFile), expectedImmediateFolder);
	});
});

describe("Managing separate or shared SQL, SQL Server, and PostgreSQL language server instances", () => {
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

	test("coalesces sqlserver into the canonical sql server instance by default when command and arguments match", async () => {
		const workspaceFolder = createTemporaryWorkspaceFolder();
		temporaryFolders.push(workspaceFolder);
		writeFileSync(path.join(workspaceFolder, "Database.sqlproj"), "<Project />", "utf8");
		const sqlFile = createNestedFile(workspaceFolder, "queries/orders.sql", "SELECT * FROM dbo.Orders;\n");
		const tsqlFile = createNestedFile(
			workspaceFolder,
			"dbo/StoredProcedures/usp_GetOrders.tsql",
			"CREATE PROCEDURE dbo.usp_GetOrders AS SELECT * FROM dbo.Orders;\n",
		);

		const manager = new LspManager(createFreshConfigCopy(), async () => true, spawnFakeServerProcess);
		managersToStop.push(manager);

		const sqlSession = await manager.ensure("sql", sqlFile);
		const sqlserverSession = await manager.ensure("sqlserver", tsqlFile);

		assert.equal(sqlSession.client, sqlserverSession.client);
		assert.equal(spawnedServerProcesses.length, 1);
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

	test("isolates sqlserver into a separate server instance when command or args are overridden in lsp.json", async () => {
		// Subcase 1: Overridden command
		const workspaceFolderOne = createTemporaryWorkspaceFolder();
		temporaryFolders.push(workspaceFolderOne);
		writeFileSync(path.join(workspaceFolderOne, "Database.sqlproj"), "<Project />", "utf8");
		const sqlFileOne = createNestedFile(workspaceFolderOne, "queries/orders.sql", "SELECT * FROM dbo.Orders;\n");
		const tsqlFileOne = createNestedFile(
			workspaceFolderOne,
			"dbo/StoredProcedures/usp_GetOrders.tsql",
			"CREATE PROCEDURE dbo.usp_GetOrders AS SELECT 1;\n",
		);

		const overriddenCommandConfig = createFreshConfigCopy();
		overriddenCommandConfig.servers.sqlserver = {
			command: "sqruff",
			args: ["lsp"],
			rootMarkers: ["*.sqlproj", ".git"],
			enabled: true,
		};

		const commandManager = new LspManager(overriddenCommandConfig, async () => true, spawnFakeServerProcess);
		managersToStop.push(commandManager);

		const sqlSessionOne = await commandManager.ensure("sql", sqlFileOne);
		const sqlserverSessionOne = await commandManager.ensure("sqlserver", tsqlFileOne);

		assert.notEqual(sqlSessionOne.client, sqlserverSessionOne.client);
		assert.deepEqual(commandManager.status(), [
			{
				language: "sql",
				root: workspaceFolderOne,
				running: true,
				openFiles: 1,
				diagnosticUris: 0,
			},
			{
				language: "sqlserver",
				root: workspaceFolderOne,
				running: true,
				openFiles: 1,
				diagnosticUris: 0,
			},
		]);

		// Subcase 2: Same command, overridden args
		const workspaceFolderTwo = createTemporaryWorkspaceFolder();
		temporaryFolders.push(workspaceFolderTwo);
		writeFileSync(path.join(workspaceFolderTwo, ".git"), "", "utf8");
		const sqlFileTwo = createNestedFile(workspaceFolderTwo, "queries/ansi.sql", "SELECT 1;\n");
		const tsqlFileTwo = createNestedFile(workspaceFolderTwo, "queries/mssql.tsql", "SELECT TOP 1 1;\n");

		const overriddenArgsConfig = createFreshConfigCopy();
		overriddenArgsConfig.servers.sql = {
			command: "sqls",
			args: ["-config", "ansi.yml"],
			rootMarkers: [".git"],
			enabled: true,
		};
		overriddenArgsConfig.servers.sqlserver = {
			command: "sqls",
			args: ["-config", "tsql.yml"],
			rootMarkers: [".git"],
			enabled: true,
		};

		const argsManager = new LspManager(overriddenArgsConfig, async () => true, spawnFakeServerProcess);
		managersToStop.push(argsManager);

		const sqlSessionTwo = await argsManager.ensure("sql", sqlFileTwo);
		const sqlserverSessionTwo = await argsManager.ensure("sqlserver", tsqlFileTwo);

		assert.notEqual(sqlSessionTwo.client, sqlserverSessionTwo.client);
		assert.deepEqual(argsManager.status(), [
			{
				language: "sql",
				root: workspaceFolderTwo,
				running: true,
				openFiles: 1,
				diagnosticUris: 0,
			},
			{
				language: "sqlserver",
				root: workspaceFolderTwo,
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

	test("refuses to start sqlserver when disabled or when its executable is missing and surfaces SQL Server installation hints", async () => {
		const workspaceFolder = createTemporaryWorkspaceFolder();
		temporaryFolders.push(workspaceFolder);
		const tsqlFile = createNestedFile(workspaceFolder, "procs/check.tsql", "SELECT 1;\n");

		const disabledSqlServerConfig = createFreshConfigCopy();
		disabledSqlServerConfig.servers.sqlserver.enabled = false;
		const disabledManager = new LspManager(disabledSqlServerConfig, async () => true, spawnFakeServerProcess);
		managersToStop.push(disabledManager);

		await assert.rejects(
			disabledManager.ensure("sqlserver", tsqlFile),
			(err: unknown) =>
				err instanceof Error &&
				err.message.includes("LSP for sqlserver is disabled in lsp.json (servers.sqlserver.enabled=false)."),
		);

		const missingBinaryManager = new LspManager(createFreshConfigCopy(), async () => false, spawnFakeServerProcess);
		managersToStop.push(missingBinaryManager);

		await assert.rejects(
			missingBinaryManager.ensure("sqlserver", tsqlFile),
			(err: unknown) => err instanceof Error && err.message.includes(INSTALL_HINTS.sqlserver),
		);
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

	test("stops the coalesced sql server instance when restart(\"sqlserver\") is called under default configuration", async () => {
		const workspaceFolder = createTemporaryWorkspaceFolder();
		temporaryFolders.push(workspaceFolder);
		writeFileSync(path.join(workspaceFolder, "Database.sqlproj"), "<Project />", "utf8");
		const tsqlFile = createNestedFile(
			workspaceFolder,
			"dbo/StoredProcedures/usp_Cleanup.tsql",
			"CREATE PROCEDURE dbo.usp_Cleanup AS SELECT 1;\n",
		);

		const manager = new LspManager(createFreshConfigCopy(), async () => true, spawnFakeServerProcess);
		managersToStop.push(manager);

		await manager.ensure("sqlserver", tsqlFile);
		assert.equal(manager.status().length, 1);
		assert.equal(manager.status()[0]?.language, "sql");

		await manager.restart("sqlserver");
		assert.deepEqual(manager.status(), []);
	});
});

describe("End-to-end tool execution for SQL, SQL Server, and PostgreSQL files", () => {
	test("executes the full LSP tool lifecycle (lsp_diagnostics, lsp_hover, lsp_definition, lsp_document_symbols, lsp_workspace_symbols) for a .tsql file with sqlserver and sends languageId tsql", async () => {
		const workspaceFolder = createTemporaryWorkspaceFolder();
		temporaryFolders.push(workspaceFolder);
		writeFileSync(path.join(workspaceFolder, "Warehouse.sqlproj"), "<Project />", "utf8");
		const tsqlContent =
			"CREATE PROCEDURE dbo.usp_GetCustomerOrders\nAS\nBEGIN\n    SELECT OrderId FROM dbo.Orders;\nEND;\n";
		const tsqlFile = createNestedFile(
			workspaceFolder,
			"dbo/StoredProcedures/usp_GetCustomerOrders.tsql",
			tsqlContent,
		);
		const expectedUri = pathToUri(tsqlFile);

		const manager = new LspManager(createFreshConfigCopy(), async () => true, spawnFakeServerProcess);
		managersToStop.push(manager);
		const registeredTools = createToolRegistrationHarness(manager, workspaceFolder);

		const diagnosticsTool = registeredTools.get("lsp_diagnostics")!;
		const hoverTool = registeredTools.get("lsp_hover")!;
		const definitionTool = registeredTools.get("lsp_definition")!;
		const documentSymbolsTool = registeredTools.get("lsp_document_symbols")!;
		const workspaceSymbolsTool = registeredTools.get("lsp_workspace_symbols")!;

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
							end: { line: 0, character: 16 },
						},
						severity: 2,
						message: "Procedure should include SET NOCOUNT ON.",
						source: "sql-language-server",
					},
				],
			});
		};

		nextRequestResponder = (_serverProcess, message) => {
			if (message.method === "textDocument/hover") {
				return {
					contents: {
						kind: "markdown",
						value: "```tsql\nPROCEDURE dbo.usp_GetCustomerOrders\n```",
					},
				};
			}
			if (message.method === "textDocument/definition") {
				return {
					uri: expectedUri,
					range: {
						start: { line: 0, character: 17 },
						end: { line: 0, character: 42 },
					},
				};
			}
			if (message.method === "textDocument/documentSymbol") {
				return [
					{
						name: "dbo.usp_GetCustomerOrders",
						kind: 12,
						range: {
							start: { line: 0, character: 0 },
							end: { line: 4, character: 4 },
						},
						selectionRange: {
							start: { line: 0, character: 17 },
							end: { line: 0, character: 42 },
						},
					},
				];
			}
			if (message.method === "workspace/symbol") {
				return [
					{
						name: "dbo.usp_GetCustomerOrders",
						kind: 12,
						location: {
							uri: expectedUri,
							range: {
								start: { line: 0, character: 17 },
								end: { line: 0, character: 42 },
							},
						},
					},
				];
			}
			return undefined;
		};

		// 1 & 2. lsp_diagnostics + textDocument/didOpen verification
		const diagResponse = await diagnosticsTool.execute("call-tsql-diag", {
			file: tsqlFile,
		});
		assert.notEqual(openedDocumentDetails, undefined);
		assert.equal(openedDocumentDetails?.languageId, "tsql");
		assert.equal(openedDocumentDetails?.text, tsqlContent);
		assert.equal(diagResponse.isError, undefined);
		assert.deepEqual(diagResponse.structuredContent, {
			diagnostics: [
				{
					uri: expectedUri,
					path: uriToPath(expectedUri),
					line: 1,
					character: 1,
					message: "Procedure should include SET NOCOUNT ON.",
					severity: 2,
				},
			],
		});

		// 3. lsp_hover
		const hoverResponse = await hoverTool.execute("call-tsql-hover", {
			file: tsqlFile,
			line: 1,
			character: 18,
		});
		assert.equal(hoverResponse.isError, undefined);
		assert.deepEqual(hoverResponse.structuredContent, {
			text: "```tsql\nPROCEDURE dbo.usp_GetCustomerOrders\n```",
			uri: expectedUri,
		});
		const hoverRequest = spawnedServerProcesses[0]?.sentMessages.find((m) => m.method === "textDocument/hover");
		assert.deepEqual(hoverRequest?.params, {
			textDocument: { uri: expectedUri },
			position: { line: 0, character: 17 },
		});

		// 4. lsp_definition
		const definitionResponse = await definitionTool.execute("call-tsql-def", {
			file: tsqlFile,
			line: 1,
			character: 18,
		});
		assert.equal(definitionResponse.isError, undefined);
		assert.deepEqual(definitionResponse.structuredContent, {
			locations: [
				{
					uri: expectedUri,
					path: uriToPath(expectedUri),
					line: 1,
					character: 18,
				},
			],
		});

		// 5. lsp_document_symbols
		const docSymbolsResponse = await documentSymbolsTool.execute("call-tsql-doc-sym", {
			file: tsqlFile,
		});
		assert.equal(docSymbolsResponse.isError, undefined);
		assert.equal(docSymbolsResponse.content[0]?.text, "- dbo.usp_GetCustomerOrders (12)");
		assert.equal(docSymbolsResponse.details.count, 1);

		// 6. lsp_workspace_symbols
		const workspaceSymbolsResponse = await workspaceSymbolsTool.execute("call-tsql-ws-sym", {
			language: "sqlserver" as SupportedLanguage,
			query: "usp_GetCustomerOrders",
		});
		assert.equal(workspaceSymbolsResponse.isError, undefined);
		assert.equal(
			workspaceSymbolsResponse.content[0]?.text,
			`- dbo.usp_GetCustomerOrders — ${uriToPath(expectedUri)}:1:18`,
		);
		assert.equal(workspaceSymbolsResponse.details.count, 1);
	});

	test("rejects cross-dialect tool calls (sqlserver on .pgsql and postgres on .tsql) in lsp_hover and lsp_definition without spawning a server", async () => {
		const workspaceFolder = createTemporaryWorkspaceFolder();
		temporaryFolders.push(workspaceFolder);
		const pgsqlFile = createNestedFile(workspaceFolder, "queries/notify.pgsql", "SELECT pg_notify('ch', 'hi');\n");
		const tsqlFile = createNestedFile(
			workspaceFolder,
			"dbo/StoredProcedures/usp_GetOrders.tsql",
			"CREATE PROCEDURE dbo.usp_GetOrders AS SELECT 1;\n",
		);

		const manager = new LspManager(createFreshConfigCopy(), async () => true, spawnFakeServerProcess);
		managersToStop.push(manager);
		const registeredTools = createToolRegistrationHarness(manager, workspaceFolder);
		const hoverTool = registeredTools.get("lsp_hover")!;
		const definitionTool = registeredTools.get("lsp_definition")!;

		const hoverResponse = await hoverTool.execute("call-cross-hover", {
			language: "sqlserver" as SupportedLanguage,
			file: pgsqlFile,
			line: 1,
			character: 1,
		});

		assert.equal(hoverResponse.isError, true);
		assert.equal(hoverResponse.details.tool, "lsp_hover");
		assert.equal(hoverResponse.details.inferred, "postgres");
		assert.equal(hoverResponse.details.explicit, "sqlserver");
		assert.ok(String(hoverResponse.details.error).includes("Language mismatch: inferred postgres but got sqlserver"));
		assert.equal(spawnedServerProcesses.length, 0);

		const definitionResponse = await definitionTool.execute("call-cross-def", {
			language: "postgres" as SupportedLanguage,
			file: tsqlFile,
			line: 1,
			character: 1,
		});

		assert.equal(definitionResponse.isError, true);
		assert.equal(definitionResponse.details.tool, "lsp_definition");
		assert.equal(definitionResponse.details.inferred, "sqlserver");
		assert.equal(definitionResponse.details.explicit, "postgres");
		assert.ok(
			String(definitionResponse.details.error).includes("Language mismatch: inferred sqlserver but got postgres"),
		);
		assert.equal(spawnedServerProcesses.length, 0);
	});

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
