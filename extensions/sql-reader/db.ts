/** Dialect dispatch: connect, run read-only queries + catalog introspection. */

import { createRequire } from "node:module";
import { defaultPort, pgSslOption, tediousTlsFragment, type ConnParams } from "./tls.ts";

const require = createRequire(import.meta.url);
// CJS interop: pg/tedious ship CJS; require works under both CJS and jiti ESM.
const { Client: PgClient } = require("pg") as typeof import("pg");
const tedious = require("tedious") as typeof import("tedious");
const { Connection, Request, TYPES } = tedious;

export interface Tabular {
  columns: string[];
  rows: Record<string, unknown>[];
}

function timeouts(conn: ConnParams): { connectMs: number; queryMs: number } {
  return {
    connectMs: conn.connectionTimeoutMs ?? 15000,
    queryMs: conn.queryTimeoutMs ?? 30000,
  };
}

// ---------- postgres ----------

async function pgRun(
  conn: ConnParams,
  text: string,
  values: unknown[] = [],
  signal?: AbortSignal,
): Promise<Tabular> {
  const { connectMs, queryMs } = timeouts(conn);
  const client = new PgClient({
    host: conn.host,
    port: conn.port ?? defaultPort("postgres"),
    database: conn.database,
    user: conn.user,
    password: conn.password,
    ssl: pgSslOption(conn),
    connectionTimeoutMillis: connectMs,
    query_timeout: queryMs,
    statement_timeout: queryMs,
  });
  const abort = (reason: unknown): never => {
    client.end().catch(() => {});
    throw reason instanceof Error ? reason : new Error("Aborted");
  };
  if (signal?.aborted) abort(signal.reason);
  const onAbort = () => abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  await client.connect().catch((e: unknown) => {
    signal?.removeEventListener("abort", onAbort);
    throw e;
  });
  try {
    const res = await client.query(text, values as unknown[]);
    return { columns: res.fields.map((f) => f.name), rows: res.rows as Record<string, unknown>[] };
  } catch (e) {
    if (signal?.aborted) abort(signal.reason);
    throw e;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await client.end().catch(() => {});
  }
}

// ---------- sql server (tedious) ----------

function tediousConfig(conn: ConnParams): unknown {
  const { connectMs, queryMs } = timeouts(conn);
  return {
    server: conn.host,
    options: {
      port: conn.port ?? defaultPort("sqlserver"),
      database: conn.database,
      requestTimeout: queryMs,
      connectTimeout: connectMs,
      ...tediousTlsFragment(conn),
      rowCollectionOnRequestCompletion: false,
      useUTC: true,
      appName: "pi-sql-reader",
    },
    authentication: {
      type: "default",
      options: { userName: conn.user, password: conn.password },
    },
  };
}

function tediousRun(
  conn: ConnParams,
  sqlText: string,
  params: { name: string; type: unknown; value: unknown }[] = [],
  signal?: AbortSignal,
): Promise<Tabular> {
  const config = tediousConfig(conn) as ConstructorParameters<typeof Connection>[0];
  return new Promise((resolve, reject) => {
    const connection = new Connection(config);
    const columns: string[] = [];
    const rows: Record<string, unknown>[] = [];
    let settled = false;
    const done = (err: Error | null, result?: Tabular) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      try { connection.close(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(result!);
    };
    const onAbort = () => done(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    connection.on("connect", (err: Error | undefined) => {
      if (err) { done(err); return; }
      const request = new Request(sqlText, (reqErr: Error | null) => {
        if (reqErr) done(reqErr);
        else done(null, { columns, rows });
      });
      for (const p of params) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        request.addParameter(p.name, p.type as any, p.value as any);
      }
      request.on("row", (cols: { metadata: { colName: string }; value: unknown }[]) => {
        if (columns.length === 0) {
          for (const c of cols) columns.push(c.metadata.colName);
        }
        const row: Record<string, unknown> = {};
        for (const c of cols) row[c.metadata.colName] = c.value;
        rows.push(row);
      });
      connection.execSql(request);
    });
    connection.on("error", (err: Error) => done(err));
    connection.connect();
  });
}

export function runQuery(conn: ConnParams, sqlText: string, signal?: AbortSignal): Promise<Tabular> {
  if (conn.dialect === "postgres") {
    // User SQL is passed verbatim; no parameter binding is offered.
    return pgRun(conn, sqlText, [], signal);
  }
  return tediousRun(conn, sqlText, [], signal);
}

// ---------- introspection ----------

export async function listTables(conn: ConnParams, schema?: string, signal?: AbortSignal): Promise<Tabular> {
  if (conn.dialect === "postgres") {
    const where: string[] = ["table_schema NOT IN ('pg_catalog','information_schema')"];
    const values: unknown[] = [];
    if (schema) { values.push(schema); where.push(`table_schema = $${values.length}`); }
    return pgRun(
      conn,
      `SELECT table_schema AS "schema", table_name AS "name", table_type AS "type"
       FROM information_schema.tables WHERE ${where.join(" AND ")} ORDER BY 1, 2`,
      values,
      signal,
    );
  }
  const where = ["TABLE_SCHEMA NOT IN ('sys','INFORMATION_SCHEMA')"];
  const params: { name: string; value: unknown }[] = [];
  if (schema) { params.push({ name: "schema", value: schema }); where.push("TABLE_SCHEMA = @schema"); }
  return tediousRun(
    conn,
    `SELECT TABLE_SCHEMA AS "schema", TABLE_NAME AS "name", TABLE_TYPE AS "type"
     FROM INFORMATION_SCHEMA.TABLES WHERE ${where.join(" AND ")} ORDER BY 1, 2`,
    params.map((p) => ({ ...p, type: TYPES.NVarChar })),
    signal,
  );
}

export async function listColumns(conn: ConnParams, schema: string, table?: string, signal?: AbortSignal): Promise<Tabular> {
  if (conn.dialect === "postgres") {
    const values: unknown[] = [schema];
    let extra = "";
    if (table) { values.push(table); extra = ` AND table_name = $${values.length}`; }
    return pgRun(
      conn,
      `SELECT table_schema AS "schema", table_name AS "table", column_name AS "name",
              data_type AS "dataType", udt_name AS "udt", is_nullable AS "nullable",
              column_default AS "defaultValue",
              character_maximum_length AS "maxLength",
              numeric_precision AS "precision", numeric_scale AS "scale",
              ordinal_position AS "position"
       FROM information_schema.columns WHERE table_schema = $1${extra} ORDER BY 2, 6`,
      values,
      signal,
    );
  }
  const params: { name: string; type: unknown; value: unknown }[] = [
    { name: "schema", type: TYPES.NVarChar, value: schema },
  ];
  let extra = "";
  if (table) { params.push({ name: "table", type: TYPES.NVarChar, value: table }); extra = " AND TABLE_NAME = @table"; }
  return tediousRun(
    conn,
    `SELECT TABLE_SCHEMA AS "schema", TABLE_NAME AS "table", COLUMN_NAME AS "name",
            DATA_TYPE AS "dataType", IS_NULLABLE AS "nullable",
            COLUMN_DEFAULT AS "defaultValue",
            CHARACTER_MAXIMUM_LENGTH AS "maxLength",
            NUMERIC_PRECISION AS "precision", NUMERIC_SCALE AS "scale",
            ORDINAL_POSITION AS "position"
     FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @schema${extra} ORDER BY 2, 10`,
    params,
    signal,
  );
}

export async function listDataTypes(conn: ConnParams, signal?: AbortSignal): Promise<Tabular> {
  if (conn.dialect === "postgres") {
    return pgRun(
      conn,
      `SELECT data_type AS "type", COUNT(*)::int AS "columns", COUNT(DISTINCT table_schema || '.' || table_name)::int AS "tables"
       FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog','information_schema')
       GROUP BY 1 ORDER BY 1`,
      [],
      signal,
    );
  }
  return tediousRun(
    conn,
    `SELECT DATA_TYPE AS "type", COUNT(*) AS "columns",
            COUNT(DISTINCT TABLE_SCHEMA + '.' + TABLE_NAME) AS "tables"
     FROM INFORMATION_SCHEMA.COLUMNS GROUP BY DATA_TYPE ORDER BY 1`,
    [],
    signal,
  );
}

export async function ping(conn: ConnParams, signal?: AbortSignal): Promise<{ version: string; latencyMs: number }> {
  const t0 = Date.now();
  try {
    const res = conn.dialect === "postgres"
      ? await pgRun(conn, "SELECT version() AS version", [], signal)
      : await tediousRun(conn, "SELECT @@VERSION AS version", [], signal);
    const version = String(res.rows[0]?.version ?? "(unknown)");
    return { version, latencyMs: Date.now() - t0 };
  } catch (e) {
    // Fall back to a bare SELECT 1: proves connectivity even when the
    // version function is unavailable (restricted roles, emulators).
    if (conn.dialect === "postgres") {
      await pgRun(conn, "SELECT 1 AS one", [], signal);
    } else {
      await tediousRun(conn, "SELECT 1 AS one", [], signal);
    }
    return { version: `(unavailable: ${(e as Error)?.message ?? e})`, latencyMs: Date.now() - t0 };
  }
}
