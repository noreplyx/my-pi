/**
 * sql-reader — read-only SQL Server + Postgres reader for Pi.
 *
 * Single tool `sql_reader` with `action` dispatch:
 *   query | plan | tables | columns | indexes | schema | datatypes | ping
 * TLS and plaintext both supported per call; credentials are per-call only
 * and never persisted. Connections are opened lazily inside execute() and
 * always closed (no long-lived sockets from the factory).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatIndexRow, getMssqlPlan, getPgPlan, listColumns, listDataTypes, listIndexes, listTables, ping, runQuery, type Tabular } from "./db.ts";
import { connLabel, tlsSummary, type ConnParams } from "./tls.ts";
import { appendLimit, clampRows, truncateCell, validateReadOnlySql } from "./validate.ts";

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

const SqlReaderParams = Type.Object({
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
    ],
    { description: "query=run read-only SELECT (EXPLAIN… allowed); plan=query planner (estimated by default, executed when analyze=true); tables=list tables/views; columns=column types; indexes=indexes with key columns/uniqueness/primary/type; schema=tables+columns+indexes; datatypes=distinct types; ping=connectivity+version." },
  ),
  dialect: Dialect,
  host: Type.String({ description: "DB hostname or IP." }),
  port: Type.Optional(Type.Integer({ description: "Port (default 5432 pg / 1433 mssql).", minimum: 1, maximum: 65535 })),
  database: Type.String({ description: "Database name." }),
  user: Type.String({ description: "Login user (prefer ephemeral read-only creds)." }),
  password: Type.String({ description: "Login password (per-call only, never persisted; redacted in output)." }),
  tls: Tls,
  connectionTimeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 120000, default: 15000 })),
  queryTimeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300000, default: 30000 })),
  sql: Type.Optional(Type.String({ description: "Single read-only SELECT/WITH statement (query + plan actions). For query, a leading EXPLAIN… is allowed (incl. EXPLAIN ANALYZE / EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)). For plan, pass the plain SELECT/WITH to explain." })),
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
});

// Machine-readable result shapes for codemode scripts (see outputSchema below).
const SqlReaderOutputSchema = Type.Object(
  {
    columns: Type.Optional(Type.Array(Type.String())),
    rows: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Any()))),
    tables: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Any()))),
    indexes: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Any()))),
    rowCount: Type.Optional(Type.Integer()),
    tableCount: Type.Optional(Type.Integer()),
    indexCount: Type.Optional(Type.Integer()),
    truncated: Type.Optional(Type.Boolean()),
    version: Type.Optional(Type.String()),
    latencyMs: Type.Optional(Type.Integer()),
    planText: Type.Optional(Type.String()),
    planJson: Type.Optional(Type.Any()),
    executed: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);

const SCHEMA_TABLE_CAP = 200;
// Plans (esp. XML) can be large; cap what we return to keep tool output sane.
const MAX_PLAN_CHARS = 100_000;
const PLAN_DISPLAY_CHARS = 12_000;

type Params = {
  action: "query" | "plan" | "tables" | "columns" | "indexes" | "schema" | "datatypes" | "ping";
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

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "sql_reader",
    label: "SQL Reader",
    description: [
      "Read-only reader for Postgres and SQL Server (TLS or plaintext).",
      "Actions: query (single SELECT/WITH only, blocked otherwise; limit enforced server-side; EXPLAIN… allowed), plan (query planner: estimated by default, actual when analyze=true executes the query), tables, columns, indexes,",
      "schema, datatypes, ping. Credentials are per-call and never stored.",
      "Set tls.mode=tls for encrypted connections; use rejectUnauthorized=false only",
      "for self-signed dev certs, caPem for private CAs.",
    ].join(" "),
    parameters: SqlReaderParams,
    outputSchema: SqlReaderOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },

    async execute(_toolCallId, rawParams, signal, _onUpdate, _ctx) {
      const params = rawParams as Params;
      const t0 = Date.now();
      const fail = (text: string) => ({
        content: [{ type: "text" as const, text }],
        details: { action: params.action, dialect: params.dialect, target: connLabel(toConn(params)), tls: tlsSummary(toConn(params)), error: text },
        isError: true,
      });
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
            details: { action: "ping", target: label, tls, version, latencyMs, elapsedMs: elapsed() },
            structuredContent: { version, latencyMs },
          };
        }

        if (params.action === "tables") {
          const t = await listTables(conn, params.schema, signal);
          const text = `Tables in ${label} schema=${params.schema ?? "(all)"} (${t.rows.length}):\n${mdTable(t, 50)}`;
          return {
            content: [{ type: "text" as const, text }],
            details: { action: "tables", target: label, tls, tables: t.rows, elapsedMs: elapsed() },
            structuredContent: { tables: t.rows },
          };
        }

        if (params.action === "columns") {
          const schema = params.schema ?? defaultSchema(params.dialect);
          const t = await listColumns(conn, schema, params.table, signal);
          const text = `Columns in ${label} ${schema}${params.table ? "." + params.table : ""} (${t.rows.length}):\n${mdTable(t, 100)}`;
          return {
            content: [{ type: "text" as const, text }],
            details: { action: "columns", target: label, tls, columns: t.rows, elapsedMs: elapsed() },
            structuredContent: { columns: t.rows },
          };
        }

        if (params.action === "indexes") {
          const schema = params.schema ?? defaultSchema(params.dialect);
          const t = await listIndexes(conn, schema, params.table, signal);
          const text = `Indexes in ${label} ${schema}${params.table ? "." + params.table : ""} (${t.rows.length}):\n${mdTable(t, 100)}`;
          return {
            content: [{ type: "text" as const, text }],
            details: { action: "indexes", target: label, tls, indexes: t.rows, indexCount: t.rows.length, elapsedMs: elapsed() },
            structuredContent: { indexes: t.rows, indexCount: t.rows.length },
          };
        }

        if (params.action === "datatypes") {
          const t = await listDataTypes(conn, signal);
          const text = `Data types in ${label} (${t.rows.length}):\n${mdTable(t, 50)}`;
          return {
            content: [{ type: "text" as const, text }],
            details: { action: "datatypes", target: label, tls, types: t.rows, elapsedMs: elapsed() },
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
            details: { action: "schema", target: label, tls, tables: shownTables, columns: shownCols, indexes: shownIdx, tableCount: tables.rows.length, indexCount: idx.rows.length, truncated, elapsedMs: elapsed() },
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
            // Full-option passthrough: user already wrote EXPLAIN (ANALYZE, …).
            // Run verbatim (no LIMIT wrap, no rebuild) so any option set works.
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
              details: { action: "plan", target: label, tls, columns: t.columns, rowCount: t.rows.length, truncated, elapsedMs: elapsed() },
              structuredContent: { columns: t.columns, rows: t.rows, rowCount: t.rows.length, planText: sliced, ...(planJson !== undefined ? { planJson } : {}), truncated },
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
            details: { action: "plan", target: label, tls, columns: plan.tabular.columns, rowCount: plan.tabular.rows.length, truncated, executed: plan.executed, elapsedMs: elapsed() },
            structuredContent: { columns: plan.tabular.columns, rows: plan.tabular.rows, rowCount: plan.tabular.rows.length, planText: sliced, ...(plan.planJson !== undefined ? { planJson: plan.planJson } : {}), executed: plan.executed, truncated },
          };
        }

        // action === "query"
        if (!params.sql) return fail("query action requires `sql` (a single read-only SELECT/WITH statement).");
        const check = validateReadOnlySql(params.sql);
        if (!check.ok) return fail(`Blocked: ${check.error}`);
        const { rows: cap } = clampRows(params.limit, params.maxRows);
        // Cap is enforced server-side (LIMIT/TOP wrapper); the slice below is a backstop.
        const t = await runQuery(conn, appendLimit(params.sql, cap, params.dialect), signal);
        const truncated = t.rows.length >= cap;
        const shown = t.rows.slice(0, cap);
        const view: Tabular = { columns: t.columns, rows: shown };
        const text = `Query OK ${label} (${t.rows.length} rows${truncated ? `, capped at ${cap}` : ""}, ${elapsed()}ms):\n${mdTable(view)}`;
        return {
          content: [{ type: "text" as const, text }],
          details: { action: "query", target: label, tls, columns: t.columns, rowCount: t.rows.length, truncated, elapsedMs: elapsed() },
          structuredContent: { columns: t.columns, rows: shown, rowCount: t.rows.length, truncated },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return fail(`Database error: ${msg}`);
      }
    },

    renderCall(args, theme, _context) {
      const a = args as Partial<Params>;
      let text = theme.fg("toolTitle", theme.bold("sql_reader ")) +
        theme.fg("accent", `${a.dialect ?? "?"}:${a.action ?? "?"}`);
      if (a.host && a.database) text += theme.fg("muted", ` @${a.host}/${a.database}`);
      if (a.action === "plan" && (a as Partial<Params>).analyze) text += theme.fg("accent", " [analyze]");
      if (typeof a.sql === "string" && a.sql) {
        const oneLine = a.sql.replace(/\s+/g, " ").trim();
        const preview = oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
        text += `\n  ${theme.fg("dim", preview)}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const d = result.details as { action?: string; rowCount?: number; truncated?: boolean; error?: string } | undefined;
      const first = result.content[0];
      const body = first?.type === "text" ? first.text : "(no output)";
      const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      let header = `${icon} ${theme.fg("toolTitle", theme.bold("sql_reader"))}`;
      if (d?.action) header += ` ${theme.fg("accent", d.action)}`;
      if (typeof d?.rowCount === "number") header += theme.fg("muted", ` (${d.rowCount} rows${d.truncated ? ", truncated" : ""})`);
      const text = expanded ? `${header}\n${theme.fg("toolOutput", body)}` : `${header}\n${theme.fg("toolOutput", body.split("\n").slice(0, 12).join("\n"))}`;
      return new Text(text, 0, 0);
    },
  });
}
