/**
 * sql-tool — Postgres + SQL Server reader/writer for Pi.
 *
 * Canonical tool `sql-tool` (label "SQL Tool") with `action` dispatch:
 *   query | plan | tables | columns | indexes | schema | datatypes | ping (read)
 *   write | preview (write, gated)
 * Deprecated alias `sql_reader` delegates to the same execute and marks
 * details.deprecatedAlias=true (read-only params still work).
 *
 * TLS and plaintext both supported per call; credentials are per-call only
 * and never persisted or logged. Connections are opened lazily inside
 * execute() and always closed (no long-lived sockets from the factory).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildWritePreview, formatIndexRow, getMssqlPlan, getPgPlan, listColumns, listDataTypes, listIndexes, listTables, ping, runQuery, runWrite, type Tabular } from "./db.ts";
import { connLabel, defaultPort, tlsSummary, type ConnParams } from "./tls.ts";
import { appendLimit, clampRows, truncateCell, validateReadOnlySql, validateWriteSql } from "./validate.ts";

const Dialect = Type.Union([Type.Literal("postgres"), Type.Literal("sqlserver")], {
  description: 'Database engine. "postgres" or "sqlserver".',
});

const Tls = Type.Optional(
  Type.Object({
    mode: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("tls")], {
      description: 'TLS mode. "off" = plaintext (default), "tls" = encrypted.',
      default: "off",
    })),
    rejectUnauthorized: Type.Optional(
      Type.Boolean({ description: "Verify server certificate (default true when mode=tls).", default: true }),
    ),
    caPem: Type.Optional(Type.String({ description: "PEM CA bundle for private/self-signed CAs." })),
    serverName: Type.Optional(Type.String({ description: "SNI / hostname-verification override." })),
  }),
);

const SqlToolParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("query"),
      Type.Literal("plan"),
      Type.Literal("tables"),
      Type.Literal("columns"),
      Type.Literal("indexes"),
      Type.Literal("schema"),
      Type.Literal("datatypes"),
      Type.Literal("ping"),
      Type.Literal("write"),
      Type.Literal("preview"),
    ],
    { description: "query=run read-only SELECT; plan=query planner (estimated by default); tables/columns/indexes/schema/datatypes=catalog; ping=connectivity; write=execute INSERT/UPDATE/DELETE/MERGE (DDL with allowDdl) gated by mode/dryRun/confirm; preview=write plan without mutating." },
  ),
  dialect: Dialect,
  host: Type.String({ description: "DB hostname or IP." }),
  port: Type.Optional(Type.Integer({ description: "Port (default 5432 pg / 1433 mssql).", minimum: 1, maximum: 65535 })),
  database: Type.String({ description: "Database name." }),
  user: Type.String({ description: "Login user (prefer ephemeral creds; read-only for reads)." }),
  password: Type.String({ description: "Login password (per-call only, never persisted; redacted in output)." }),
  tls: Tls,
  connectionTimeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 120000, default: 15000 })),
  queryTimeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300000, default: 30000 })),
  sql: Type.Optional(Type.String({ description: "SQL statement. Read: single SELECT/WITH (EXPLAIN… allowed) for query/plan. Write: INSERT/UPDATE/DELETE/MERGE (DDL with allowDdl) for write/preview." })),
  schema: Type.Optional(Type.String({ description: "Schema filter (default public for pg, dbo for mssql)." })),
  table: Type.Optional(Type.String({ description: "Table filter (columns + indexes actions)." })),
  limit: Type.Optional(Type.Integer({ description: "Row cap for query, enforced server-side (default 100, max 1000).", minimum: 1, maximum: 1000 })),
  maxRows: Type.Optional(Type.Integer({ description: "Alias for limit (default 100, max 1000).", minimum: 1, maximum: 1000 })),
  analyze: Type.Optional(Type.Boolean({ description: "Plan only: true = actual plan (executes the query: pg EXPLAIN ANALYZE / mssql STATISTICS XML). False (default) = estimated plan, no execution. Can be slow on large tables; bound with queryTimeoutMs." })),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json"), Type.Literal("xml"), Type.Literal("yaml")], { description: "Plan only, postgres EXPLAIN FORMAT (default text). json returns parsed planJson." })),
  verbose: Type.Optional(Type.Boolean({ description: "Plan only, postgres EXPLAIN VERBOSE." })),
  costs: Type.Optional(Type.Boolean({ description: "Plan only, postgres EXPLAIN COSTS (default on; pass false for COSTS FALSE)." })),
  buffers: Type.Optional(Type.Boolean({ description: "Plan only, postgres EXPLAIN BUFFERS." })),
  timing: Type.Optional(Type.Boolean({ description: "Plan only, postgres EXPLAIN TIMING." })),
  summary: Type.Optional(Type.Boolean({ description: "Plan only, postgres EXPLAIN SUMMARY." })),
  settings: Type.Optional(Type.Boolean({ description: "Plan only, postgres EXPLAIN SETTINGS." })),
  wal: Type.Optional(Type.Boolean({ description: "Plan only, postgres EXPLAIN WAL." })),
  planFormat: Type.Optional(Type.Union([Type.Literal("xml"), Type.Literal("all"), Type.Literal("text")], { description: "Plan only, sqlserver estimated shape (default xml SHOWPLAN_XML; all=SHOWPLAN_ALL table; text=SHOWPLAN_TEXT). Ignored for postgres and for actual (analyze=true) plans." })),
  mode: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("write")], { description: "read (default) = read-only actions; write = allow write/preview actions with dryRun/confirm + UI confirm gate.", default: "read" })),
  confirm: Type.Optional(Type.Boolean({ description: "Write gate: must be true with dryRun:false + UI confirm to execute. Default false.", default: false })),
  dryRun: Type.Optional(Type.Boolean({ description: "Write gate: true (default) = preview only, no mutation. Set false + confirm:true + UI confirm to execute.", default: true })),
  allowDdl: Type.Optional(Type.Boolean({ description: "Write: allow CREATE/ALTER/DROP/TRUNCATE. Default false.", default: false })),
  allowMulti: Type.Optional(Type.Boolean({ description: "Write: deprecated in v1 single-only, ignored. Multi-statement is blocked; send single statements. Default false.", default: false })),
  maxAffectedRows: Type.Optional(Type.Integer({ description: "Write: rollback + error when affected rows exceed this cap. Default 100.", minimum: 1, default: 100 })),
  returnRows: Type.Optional(Type.Boolean({ description: "Write: include RETURNING/result rows in output. Default true.", default: true })),
});

// Back-compat alias: old symbol name re-exported.
export { SqlToolParams };
export const SqlReaderParams = SqlToolParams;

// Machine-readable result shapes for codemode scripts (see outputSchema below).
const SqlToolOutputSchema = Type.Object(
  {
    columns: Type.Optional(Type.Array(Type.String())),
    rows: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Any()))),
    tables: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Any()))),
    indexes: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Any()))),
    rowCount: Type.Optional(Type.Integer()),
    affectedRows: Type.Optional(Type.Integer()),
    tableCount: Type.Optional(Type.Integer()),
    indexCount: Type.Optional(Type.Integer()),
    truncated: Type.Optional(Type.Boolean()),
    version: Type.Optional(Type.String()),
    latencyMs: Type.Optional(Type.Integer()),
    planText: Type.Optional(Type.String()),
    planJson: Type.Optional(Type.Any()),
    preview: Type.Optional(Type.Boolean()),
    previewText: Type.Optional(Type.String()),
    dryRun: Type.Optional(Type.Boolean()),
    executed: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);

export const SqlReaderOutputSchema = SqlToolOutputSchema;

const SCHEMA_TABLE_CAP = 200;
// Plans (esp. XML) can be large; cap what we return to keep tool output sane.
const MAX_PLAN_CHARS = 100_000;
const PLAN_DISPLAY_CHARS = 12_000;

type Params = {
  action: "query" | "plan" | "tables" | "columns" | "indexes" | "schema" | "datatypes" | "ping" | "write" | "preview";
  dialect: "postgres" | "sqlserver";
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  tls?: { mode?: "off" | "tls"; rejectUnauthorized?: boolean; caPem?: string; serverName?: string };
  connectionTimeoutMs?: number;
  queryTimeoutMs?: number;
  sql?: string;
  schema?: string;
  table?: string;
  limit?: number;
  maxRows?: number;
  analyze?: boolean;
  format?: "text" | "json" | "xml" | "yaml";
  verbose?: boolean;
  costs?: boolean;
  buffers?: boolean;
  timing?: boolean;
  summary?: boolean;
  settings?: boolean;
  wal?: boolean;
  planFormat?: "xml" | "all" | "text";
  mode?: "read" | "write";
  confirm?: boolean;
  dryRun?: boolean;
  allowDdl?: boolean;
  allowMulti?: boolean;
  maxAffectedRows?: number;
  returnRows?: boolean;
};

function toConn(p: Params): ConnParams {
  return {
    dialect: p.dialect,
    host: p.host,
    port: p.port,
    database: p.database,
    user: p.user,
    password: p.password,
    connectionTimeoutMs: p.connectionTimeoutMs,
    queryTimeoutMs: p.queryTimeoutMs,
    tls: p.tls,
  };
}

function defaultSchema(dialect: string): string {
  return dialect === "postgres" ? "public" : "dbo";
}

function dynamicAnnotations(mode: string): { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean } {
  if (mode === "write") return { readOnlyHint: false, destructiveHint: true, idempotentHint: false };
  return { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
}

type ToolUi = {
  confirm: (title: string, body: string) => Promise<boolean>;
  notify: (message: string, level?: string) => void;
  setStatus: (key: string, text: string) => void;
};

type SqlToolCtx = {
  hasUI: boolean;
  ui: ToolUi;
  signal?: AbortSignal;
};

const noopUi: ToolUi = {
  confirm: async () => false,
  notify: () => undefined,
  setStatus: () => undefined,
};

function normalizeCtx(ctx: unknown, signal?: AbortSignal): SqlToolCtx {
  const c = (ctx ?? {}) as Partial<{ hasUI: boolean; ui: Partial<ToolUi> }>;
  return {
    hasUI: c.hasUI ?? false,
    ui: {
      confirm: c.ui?.confirm?.bind(c.ui) ?? noopUi.confirm,
      notify: (c.ui?.notify as ToolUi["notify"] | undefined)?.bind(c.ui) ?? noopUi.notify,
      setStatus: (c.ui?.setStatus as ToolUi["setStatus"] | undefined)?.bind(c.ui) ?? noopUi.setStatus,
    },
    signal,
  };
}

/** Serialize mutating writes per target so concurrent runWrite calls don't interleave (mirrors git-tool). */
const writeChains = new Map<string, Promise<void>>();

function serializeWrite<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const chained = prev.then(() => gate);
  writeChains.set(key, chained.catch(() => undefined));
  return prev.then(fn).finally(release);
}

/** Per-target serialization key (never secrets): dialect/host/port/database lowercased. */
function writeTargetKey(conn: ConnParams): string {
  const port = conn.port ?? defaultPort(conn.dialect);
  return `${conn.dialect}://${conn.host}:${port}/${conn.database}`.toLowerCase();
}

function singleLineSql(sql: string, cap = 500): string {
  const oneLine = sql.replace(/\s+/g, " ").trim();
  return oneLine.length > cap ? `${oneLine.slice(0, cap)}\u2026` : oneLine;
}

function mdTable(t: Tabular, cap = 20): string {
  if (t.rows.length === 0) return "(no rows)";
  const cols = t.columns.length > 0 ? t.columns : Object.keys(t.rows[0]);
  const head = `| ${cols.join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = t.rows.slice(0, cap).map((r) =>
    `| ${cols.map((c) => truncateCell(r[c]).text.replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`,
  );
  const more = t.rows.length > cap ? `\n… ${t.rows.length - cap} more rows (see structuredContent)` : "";
  return [head, sep, ...body].join("\n") + more;
}

async function executeSqlTool(
  params: Params,
  toolCtx: SqlToolCtx = { hasUI: false, ui: noopUi },
  opts: { deprecatedAlias?: boolean } = {},
  auditEntry: (data: Record<string, unknown>) => void = () => undefined,
) {
  const signal = toolCtx.signal;
  const t0 = Date.now();
  const mode = params.mode ?? "read";
  const annotations = dynamicAnnotations(mode);
  const audit = {
    mode,
    action: params.action,
    dryRun: params.dryRun ?? true,
    confirm: params.confirm ?? false,
    allowDdl: params.allowDdl ?? false,
    allowMulti: params.allowMulti ?? false,
    maxAffectedRows: params.maxAffectedRows ?? 100,
    annotations,
    ...(opts.deprecatedAlias ? { deprecatedAlias: true } : {}),
  };
  const fail = (text: string, code?: string) => ({
    content: [{ type: "text" as const, text }],
    details: { ...audit, dialect: params.dialect, target: connLabel(toConn(params)), tls: tlsSummary(toConn(params)), error: text, ...(code ? { code } : {}) },
    isError: true as const,
  });
  // Deprecated alias is gated to read-only at runtime: static registration
  // stays write-capable (readOnlyHint:false, destructiveHint:true) for
  // fail-closed parity, so write/preview through it must fail closed rather
  // than delegate to the write-capable execute path.
  if (opts.deprecatedAlias && (mode === "write" || params.action === "write" || params.action === "preview")) {
    return fail("Blocked: deprecated alias sql_reader is read-only. Use sql-tool with mode:\"write\" for write/preview actions.", "USER_CANCELLED");
  }
  try {
    const conn = toConn(params);
    if (!conn.host || !conn.database || !conn.user) {
      return fail("Missing connection fields: host, database and user are required.");
    }
    const label = connLabel(conn);
    const tls = tlsSummary(conn);
    const elapsed = () => Date.now() - t0;

    if (params.action === "ping") {
      const { version, latencyMs } = await ping(conn, signal);
      const text = `OK ${label} (${latencyMs}ms, tls=${tls.requested})\n${version.split("\n")[0]}`;
      return {
        content: [{ type: "text" as const, text }],
        details: { ...audit, target: label, tls, version, latencyMs, elapsedMs: elapsed() },
        structuredContent: { version, latencyMs, dryRun: false },
      };
    }

    if (params.action === "tables") {
      const t = await listTables(conn, params.schema, signal);
      const text = `Tables in ${label} schema=${params.schema ?? "(all)"} (${t.rows.length}):\n${mdTable(t, 50)}`;
      return {
        content: [{ type: "text" as const, text }],
        details: { ...audit, target: label, tls, tables: t.rows, elapsedMs: elapsed() },
        structuredContent: { tables: t.rows },
      };
    }

    if (params.action === "columns") {
      const schema = params.schema ?? defaultSchema(params.dialect);
      const t = await listColumns(conn, schema, params.table, signal);
      const text = `Columns in ${label} ${schema}${params.table ? "." + params.table : ""} (${t.rows.length}):\n${mdTable(t, 100)}`;
      return {
        content: [{ type: "text" as const, text }],
        details: { ...audit, target: label, tls, columns: t.rows, elapsedMs: elapsed() },
        structuredContent: { columns: t.rows },
      };
    }

    if (params.action === "indexes") {
      const schema = params.schema ?? defaultSchema(params.dialect);
      const t = await listIndexes(conn, schema, params.table, signal);
      const text = `Indexes in ${label} ${schema}${params.table ? "." + params.table : ""} (${t.rows.length}):\n${mdTable(t, 100)}`;
      return {
        content: [{ type: "text" as const, text }],
        details: { ...audit, target: label, tls, indexes: t.rows, indexCount: t.rows.length, elapsedMs: elapsed() },
        structuredContent: { indexes: t.rows, indexCount: t.rows.length },
      };
    }

    if (params.action === "datatypes") {
      const t = await listDataTypes(conn, signal);
      const text = `Data types in ${label} (${t.rows.length}):\n${mdTable(t, 50)}`;
      return {
        content: [{ type: "text" as const, text }],
        details: { ...audit, target: label, tls, types: t.rows, elapsedMs: elapsed() },
        structuredContent: { types: t.rows },
      };
    }

    if (params.action === "schema") {
      const schema = params.schema ?? defaultSchema(params.dialect);
      const tables = await listTables(conn, schema, signal);
      const cols = await listColumns(conn, schema, undefined, signal);
      const idx = await listIndexes(conn, schema, undefined, signal);
      const truncated = tables.rows.length > SCHEMA_TABLE_CAP;
      const shownTables = tables.rows.slice(0, SCHEMA_TABLE_CAP);
      const shownNames = new Set(shownTables.map((tb) => String(tb.name)));
      const shownCols = cols.rows.filter((c) => shownNames.has(String(c.table ?? c.TABLE ?? "?")));
      const shownIdx = idx.rows.filter((r) => shownNames.has(String(r.table ?? r.TABLE ?? "?")));
      const byTable = new Map<string, Record<string, unknown>[]>();
      for (const c of shownCols) {
        const k = String(c.table ?? c.TABLE ?? "?");
        if (!byTable.has(k)) byTable.set(k, []);
        byTable.get(k)!.push(c);
      }
      const idxByTable = new Map<string, Record<string, unknown>[]>();
      for (const r of shownIdx) {
        const k = String(r.table ?? r.TABLE ?? "?");
        if (!idxByTable.has(k)) idxByTable.set(k, []);
        idxByTable.get(k)!.push(r);
      }
      const lines = shownTables.map((tb) => {
        const name = String(tb.name ?? "?");
        const members = byTable.get(name) ?? [];
        const colList = members.map((c) => `  ${c.name} ${c.dataType}(nullable=${c.nullable})`).join("\n");
        const indexes = idxByTable.get(name) ?? [];
        const idxList = indexes.map(formatIndexRow).join("\n");
        const idxSection = idxList ? `\n${idxList}` : "";
        return `${tb.schema}.${name} (${tb.type}):\n${colList || "  (no columns found)"}${idxSection}`;
      });
      const text = `Schema ${schema} in ${label}: ${shownTables.length} tables, ${shownIdx.length} indexes${truncated ? ` (showing first ${SCHEMA_TABLE_CAP} of ${tables.rows.length})` : ""}\n\n${lines.join("\n\n")}`;
      return {
        content: [{ type: "text" as const, text: text.slice(0, 12000) }],
        details: { ...audit, target: label, tls, tables: shownTables, columns: shownCols, indexes: shownIdx, tableCount: tables.rows.length, indexCount: idx.rows.length, truncated, elapsedMs: elapsed() },
        structuredContent: { tables: shownTables, indexes: shownIdx, tableCount: tables.rows.length, indexCount: idx.rows.length, truncated },
      };
    }

    if (params.action === "plan") {
      if (!params.sql) return fail("plan action requires `sql` (a single read-only SELECT/WITH statement to explain).");
      const check = validateReadOnlySql(params.sql);
      if (!check.ok) return fail(`Blocked: ${check.error}`);
      const isPgExplainPassthrough = /^\s*EXPLAIN\b/i.test(params.sql);
      if (conn.dialect === "sqlserver" && isPgExplainPassthrough) {
        return fail("EXPLAIN syntax is postgres-only. For sqlserver plan, pass the plain SELECT/WITH in `sql` and use analyze/planFormat options.");
      }
      const fmt = params.format ?? "text";
      if (conn.dialect === "postgres" && !["text", "json", "xml", "yaml"].includes(fmt)) {
        return fail(`Unsupported format "${fmt}" (expected text/json/xml/yaml).`);
      }
      if (conn.dialect === "sqlserver" && params.planFormat && !["xml", "all", "text"].includes(params.planFormat)) {
        return fail(`Unsupported planFormat "${params.planFormat}" (expected xml/all/text).`);
      }
      if (isPgExplainPassthrough && conn.dialect === "postgres") {
        const t = await runQuery(conn, params.sql, signal);
        const col = t.columns[0] ?? Object.keys(t.rows[0] ?? {})[0];
        let planJson: unknown;
        let planText: string;
        if (col && t.rows.length > 0 && typeof (t.rows[0] as Record<string, unknown>)[col] === "object") {
          planJson = (t.rows[0] as Record<string, unknown>)[col];
          planText = JSON.stringify(planJson, null, 2);
        } else if (col) {
          planText = t.rows.map((r) => String((r as Record<string, unknown>)[col] ?? "")).join("\n");
          if (/^\s*[\[{]/.test(planText.trim())) {
            try { planJson = JSON.parse(planText); } catch { /* keep text */ }
          }
        } else {
          planText = "";
        }
        const truncated = planText.length > MAX_PLAN_CHARS;
        const sliced = truncated ? planText.slice(0, MAX_PLAN_CHARS) : planText;
        const text = `Plan OK ${label} (${t.rows.length} plan rows, ${elapsed()}ms):\n${sliced.slice(0, PLAN_DISPLAY_CHARS)}${sliced.length > PLAN_DISPLAY_CHARS ? `\n… truncated to ${PLAN_DISPLAY_CHARS} chars in display (see structuredContent)` : ""}`;
        return {
          content: [{ type: "text" as const, text }],
          details: { ...audit, target: label, tls, columns: t.columns, rowCount: t.rows.length, truncated, elapsedMs: elapsed() },
          structuredContent: { columns: t.columns, rows: t.rows, rowCount: t.rows.length, planText: sliced, ...(planJson !== undefined ? { planJson } : {}), truncated, dryRun: false },
        };
      }
      const plan = conn.dialect === "postgres"
        ? await getPgPlan(conn, params.sql, {
          analyze: params.analyze,
          verbose: params.verbose,
          costs: params.costs,
          buffers: params.buffers,
          timing: params.timing,
          summary: params.summary,
          settings: params.settings,
          wal: params.wal,
          format: fmt as "text" | "json" | "xml" | "yaml",
        }, signal)
        : await getMssqlPlan(conn, params.sql, { analyze: params.analyze, planFormat: params.planFormat ?? "xml" }, signal);
      const truncated = plan.planText.length > MAX_PLAN_CHARS;
      const sliced = truncated ? plan.planText.slice(0, MAX_PLAN_CHARS) : plan.planText;
      const display = sliced.length > PLAN_DISPLAY_CHARS ? `${sliced.slice(0, PLAN_DISPLAY_CHARS)}\n… truncated to ${PLAN_DISPLAY_CHARS} chars in display (see structuredContent)` : sliced;
      const note = plan.executed ? " (actual plan — query was executed; can be slow, bounded by queryTimeoutMs)" : " (estimated plan — query was not executed)";
      const text = `Plan OK ${label}${note} (${elapsed()}ms):\n${display || "(empty plan)"}`;
      return {
        content: [{ type: "text" as const, text }],
        details: { ...audit, target: label, tls, columns: plan.tabular.columns, rowCount: plan.tabular.rows.length, truncated, executed: plan.executed, elapsedMs: elapsed() },
        structuredContent: { columns: plan.tabular.columns, rows: plan.tabular.rows, rowCount: plan.tabular.rows.length, planText: sliced, ...(plan.planJson !== undefined ? { planJson: plan.planJson } : {}), executed: plan.executed, truncated, dryRun: false },
      };
    }

    if (params.action === "query") {
      if (!params.sql) return fail("query action requires `sql` (a single read-only SELECT/WITH statement).");
      const check = validateReadOnlySql(params.sql);
      if (!check.ok) return fail(`Blocked: ${check.error}`);
      const { rows: cap } = clampRows(params.limit, params.maxRows);
      const t = await runQuery(conn, appendLimit(params.sql, cap, params.dialect), signal);
      const truncated = t.rows.length >= cap;
      const shown = t.rows.slice(0, cap);
      const view: Tabular = { columns: t.columns, rows: shown };
      const text = `Query OK ${label} (${t.rows.length} rows${truncated ? `, capped at ${cap}` : ""}, ${elapsed()}ms):\n${mdTable(view)}`;
      return {
        content: [{ type: "text" as const, text }],
        details: { ...audit, target: label, tls, columns: t.columns, rowCount: t.rows.length, truncated, elapsedMs: elapsed() },
        structuredContent: { columns: t.columns, rows: shown, rowCount: t.rows.length, truncated, dryRun: false },
      };
    }

    // write/preview actions require mode:write (fail closed).
    if (params.action === "write" || params.action === "preview") {
      if (mode !== "write") {
        return fail(`Refused: action "${params.action}" requires mode:"write" (got mode:"${mode}"). Reads stay in mode:read; writes are fail-closed.`);
      }
      if (!params.sql) return fail(`${params.action} action requires \`sql\` (INSERT/UPDATE/DELETE/MERGE; DDL with allowDdl:true).`);
      const check = validateWriteSql(params.sql, { allowDdl: params.allowDdl ?? false, allowMulti: params.allowMulti ?? false });
      if (!check.ok) return fail(`Blocked: ${check.error}`);
      const kind = check.ok ? check.kind : undefined;
      const dryRun = params.dryRun ?? true;
      const confirm = params.confirm ?? false;
      const maxAffectedRows = params.maxAffectedRows ?? 100;

      if (params.action === "preview" || dryRun) {
        toolCtx.ui.setStatus("sql-tool", "sql-tool preview\u2026");
        try {
          const preview = await buildWritePreview(conn, params.sql, signal);
          const text = `Write preview OK ${label} (no mutation, kind=${kind}, ${elapsed()}ms):\n${preview.previewText}\n${preview.planText.slice(0, PLAN_DISPLAY_CHARS) || "(no plan text)"}`;
          auditEntry({ at: new Date().toISOString(), action: params.action, kind, target: label, dryRun: true, confirm, executed: false, elapsedMs: elapsed(), annotations });
          return {
            content: [{ type: "text" as const, text }],
            details: { ...audit, target: label, tls, kind, preview: true, previewText: preview.previewText, planText: preview.planText, statements: preview.statements, statementDetails: preview.statementDetails, dryRun: true, executed: false, elapsedMs: elapsed() },
            structuredContent: { preview: true, previewText: preview.previewText, planText: preview.planText, statements: preview.statements, statementDetails: preview.statementDetails, dryRun: true, executed: false, affectedRows: 0 },
          };
        } finally {
          toolCtx.ui.setStatus("sql-tool", "");
        }
      }

      // dryRun:false path — Layer 1: requires explicit confirm:true, else fail closed (no UI prompt).
      if (!confirm) {
        return fail("Refused: write with dryRun:false requires confirm:true. Re-run with dryRun:false + confirm:true to execute, or leave dryRun:true for a preview.", "USER_CANCELLED");
      }
      // Layer 2: interactive UI confirm (mirrors git-tool core order).
      if (!toolCtx.hasUI) {
        auditEntry({ at: new Date().toISOString(), action: params.action, kind, target: label, dryRun: false, confirm, executed: false, denied: true, reason: "no-ui", elapsedMs: elapsed(), annotations });
        return fail("Refused: write needs interactive confirmation (no UI in this mode).", "USER_CANCELLED");
      }
      const confirmBody = `Target: ${label}\nKind: ${kind}\nMax affected rows: ${maxAffectedRows}\nSQL: ${singleLineSql(params.sql)}`;
      const ok = await toolCtx.ui.confirm("sql-tool: confirm write", confirmBody);
      if (!ok) {
        auditEntry({ at: new Date().toISOString(), action: params.action, kind, target: label, dryRun: false, confirm, executed: false, denied: true, elapsedMs: elapsed(), annotations });
        return fail("Cancelled by user: write not executed.", "USER_CANCELLED");
      }
      // Only action:write + dryRun:false + confirm:true + ui-confirm:true reaches runWrite (serialized per target).
      return serializeWrite(writeTargetKey(conn), async () => {
        toolCtx.ui.setStatus("sql-tool", "sql-tool write\u2026");
        try {
          const result = await runWrite(conn, params.sql as string, { maxAffectedRows }, signal);
          const wantRows = params.returnRows ?? true;
          const rows = wantRows ? result.tabular.rows.slice(0, clampRows(params.limit, params.maxRows).rows) : [];
          const text = `Write OK ${label} (affected=${result.affectedRows}, kind=${kind}, ${elapsed()}ms)${wantRows && result.tabular.rows.length > 0 ? `:\n${mdTable({ columns: result.tabular.columns, rows })}` : ""}`;
          auditEntry({ at: new Date().toISOString(), action: params.action, kind, target: label, dryRun: false, confirm, executed: true, affectedRows: result.affectedRows, elapsedMs: elapsed(), annotations });
          return {
            content: [{ type: "text" as const, text }],
            details: { ...audit, target: label, tls, kind, columns: result.tabular.columns, affectedRows: result.affectedRows, rowCount: result.affectedRows, preview: false, dryRun: false, executed: true, elapsedMs: elapsed() },
            structuredContent: { columns: result.tabular.columns, rows, affectedRows: result.affectedRows, rowCount: result.affectedRows, preview: false, dryRun: false, executed: true },
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          auditEntry({ at: new Date().toISOString(), action: params.action, kind, target: label, dryRun: false, confirm, executed: true, isError: true, error: msg, elapsedMs: elapsed(), annotations });
          throw e;
        } finally {
          toolCtx.ui.setStatus("sql-tool", "");
        }
      });
    }

    return fail(`Unknown action "${(params as { action: string }).action}".`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(`Database error: ${msg}`);
  }
}

export default function (pi: ExtensionAPI) {
  const toolDef = {
    label: "SQL Tool",
    description: [
      "Postgres + SQL Server reader/writer (TLS or plaintext).",
      "Read actions: query (single SELECT/WITH, EXPLAIN… allowed), plan (estimated by default, actual when analyze=true), tables, columns, indexes, schema, datatypes, ping.",
      "Write actions (mode:write only, v1 single-statement only): write (single INSERT/UPDATE/DELETE/MERGE; DDL with allowDdl:true; WHERE required for UPDATE/DELETE; allowMulti deprecated/ignored) and preview (no-mutation plan via EXPLAIN / SHOWPLAN_XML+NOEXEC).",
      "Write ops (dryRun preview by default; execute with dryRun:false + confirm:true + UI confirm). Gate: dryRun:true (default)=preview only; dryRun:false+confirm:true+UI confirm=execute with maxAffectedRows rollback; otherwise fail-closed (USER_CANCELLED headless/denied). Preview never requires UI.",
      "Credentials are per-call and never stored. Set tls.mode=tls for encrypted connections.",
    ].join(" "),
    parameters: SqlToolParams,
    outputSchema: SqlToolOutputSchema,
    // Static registration is write-capable (fail-closed): never advertise
    // readOnly. Per-call dynamic hints are returned in details.audit.annotations
    // as readOnlyHint=(mode==read), destructiveHint=(mode==write), idempotentHint=false on write.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async execute(_toolCallId: string, rawParams: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
      const toolCtx = normalizeCtx(ctx, signal);
      return executeSqlTool(rawParams as Params, toolCtx, {}, (data) => {
        pi.appendEntry("sql-tool-audit", { at: new Date().toISOString(), ...data });
      });
    },
    renderCall(args: unknown, theme: any, _context: unknown) {
      const a = args as Partial<Params>;
      let text = theme.fg("toolTitle", theme.bold("sql-tool ")) +
        theme.fg("accent", `${a.dialect ?? "?"}:${a.action ?? "?"}:${a.mode ?? "read"}`);
      if (a.host && a.database) text += theme.fg("muted", ` @${a.host}/${a.database}`);
      if (a.action === "plan" && (a as Partial<Params>).analyze) text += theme.fg("accent", " [analyze]");
      if ((a.action === "write" || a.action === "preview") && (a.dryRun ?? true)) text += theme.fg("accent", " [dry-run]");
      if (typeof a.sql === "string" && a.sql) {
        const oneLine = a.sql.replace(/\s+/g, " ").trim();
        const preview = oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
        text += `\n  ${theme.fg("dim", preview)}`;
      }
      return new Text(text, 0, 0);
    },
    renderResult(result: any, { expanded }: { expanded?: boolean }, theme: any, _context: unknown) {
      const d = result.details as { action?: string; affectedRows?: number; rowCount?: number; truncated?: boolean; dryRun?: boolean; error?: string } | undefined;
      const first = result.content[0];
      const body = first?.type === "text" ? first.text : "(no output)";
      const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      let header = `${icon} ${theme.fg("toolTitle", theme.bold("sql-tool"))}`;
      if (d?.action) header += ` ${theme.fg("accent", d.action)}`;
      if (typeof d?.affectedRows === "number") header += theme.fg("muted", ` (affected=${d.affectedRows})`);
      else if (typeof d?.rowCount === "number") header += theme.fg("muted", ` (${d.rowCount} rows${d.truncated ? ", truncated" : ""})`);
      if (d?.dryRun) header += theme.fg("muted", " [dry-run]");
      const text = expanded ? `${header}\n${theme.fg("toolOutput", body)}` : `${header}\n${theme.fg("toolOutput", body.split("\n").slice(0, 12).join("\n"))}`;
      return new Text(text, 0, 0);
    },
  };
  pi.registerTool({
    name: "sql-tool",
    ...toolDef,
    // Mirror git-tool: the precise internal result union does not satisfy the
    // generic ToolDefinition inference; cast the boundary (behavior unchanged).
    execute: toolDef.execute as never,
    renderCall: toolDef.renderCall as never,
    renderResult: toolDef.renderResult as never,
  });

  // Deprecated alias: read-only gate (fail-closed) + safe annotations.
  pi.registerTool({
    name: "sql_reader",
    label: "SQL Reader (deprecated, use sql-tool)",
    description: "Deprecated read-only alias of sql-tool. Write/preview actions are blocked (use sql-tool with mode:write). Read actions delegate to the same execute; details include deprecatedAlias:true. Prefer sql-tool.",
    parameters: SqlToolParams,
    outputSchema: SqlToolOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    execute: (async (_toolCallId: string, rawParams: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) => {
      const p = rawParams as { mode?: string; action?: string } | undefined;
      if (p?.mode === "write" || p?.action === "write" || p?.action === "preview") {
        const text = "Blocked: deprecated alias sql_reader is read-only. Use canonical sql-tool with mode:\"write\" for write/preview actions.";
        return { content: [{ type: "text" as const, text }], details: { deprecatedAlias: true, code: "USER_CANCELLED", error: text }, isError: true };
      }
      const toolCtx = normalizeCtx(ctx, signal);
      return executeSqlTool(rawParams as Params, toolCtx, { deprecatedAlias: true }, (data) => {
        pi.appendEntry("sql-tool-audit", { at: new Date().toISOString(), ...data });
      });
    }) as never,
    renderCall: toolDef.renderCall as never,
    renderResult: toolDef.renderResult as never,
  });
}
