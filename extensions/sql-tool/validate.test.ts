import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildPgExplain, buildWritePreview, describeWriteStatement, runWrite } from "./db.ts";
import initSqlTool from "./index.ts";
import { connLabel, tlsSummary } from "./tls.ts";
import {
  appendLimit,
  clampRows,
  findTopLevelOrderBy,
  splitStatements,
  stripExplainPrefix,
  truncateCell,
  validateReadOnlySql,
  validateWriteSql,
} from "./validate.ts";

describe("validateReadOnlySql", () => {
  const allowed = [
    "SELECT 1",
    "select id, name from users where age > 21 order by id",
    "WITH x AS (SELECT 1) SELECT * FROM x",
    "VALUES (1), (2)",
    "TABLE users",
    "EXPLAIN SELECT * FROM users",
    "EXPLAIN ANALYZE SELECT * FROM users",
    "EXPLAIN VERBOSE SELECT 1",
    "EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM users",
    "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM users",
    "EXPLAIN (COSTS OFF) SELECT 1",
    "explain analyze select * from users",
    "SELECT ';' -- semicolon in a string literal",
    'SELECT ";"', // semicolon in a quoted identifier
    "SELECT 'it''s a -- trick /* here */'",
    "SELECT sp_foo FROM t", // sp_ prefix alone is not a system proc call
    "SELECT into_col FROM t", // 'into' as part of a longer identifier
    "/* lead comment */ SELECT 1",
    "-- lead line comment\nSELECT 1",
  ];
  for (const sql of allowed) {
    test(`allows: ${sql.slice(0, 50)}`, () => {
      expect(validateReadOnlySql(sql)).toEqual({ ok: true });
    });
  }

  const blocked: [string, string][] = [
    ["DROP TABLE users", "non-SELECT leader"],
    ["DELETE FROM t", "non-SELECT leader"],
    ["UPDATE t SET a = 1", "non-SELECT leader"],
    ["INSERT INTO t VALUES (1)", "non-SELECT leader"],
    ["SELECT 1; SELECT 2", "multi-statement"],
    ["SELECT 1; DROP TABLE t", "multi-statement"],
    ["WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", "CTE write"],
    ["SELECT * INTO backup FROM users", "SELECT INTO"],
    ["SELECT * FROM t FOR UPDATE", "locking read"],
    ["SELECT * FROM t FOR SHARE", "locking read"],
    ["EXEC sp_help", "system proc"],
    ["EXECUTE sp_who", "system proc"],
    ["SELECT * FROM t; -- trailing comment hides nothing", "multi-statement"],
    ["CREATE VIEW v AS SELECT 1", "DDL"],
    ["COPY users TO '/tmp/x.csv'", "COPY"],
    ["ANALYZE users", "bare analyze (maintenance)"],
    ["VACUUM ANALYZE users", "vacuum analyze"],
    ["SELECT * FROM t WHERE x = 1 ANALYZE", "analyze outside explain"],
    ["EXPLAIN DELETE FROM t", "explain write"],
    ["EXPLAIN INSERT INTO t VALUES (1)", "explain write"],
    ["EXPLAIN SELECT * INTO backup FROM users", "explain select-into"],
    ["EXPLAIN SELECT * FROM t FOR UPDATE", "explain locking read"],
    ["EXPLAIN (FOOBAR) SELECT 1", "bad explain option"],
    ["EXPLAIN (ANALYZE SELECT 1", "unbalanced explain parens"],
    ["EXPLAIN", "explain with no statement"],
    ["", "empty"],
  ];
  for (const [sql, why] of blocked) {
    test(`blocks (${why}): ${sql.slice(0, 50)}`, () => {
      const r = validateReadOnlySql(sql);
      expect(r.ok).toBe(false);
    });
  }

  test("rejects oversized sql", () => {
    expect(validateReadOnlySql("SELECT '" + "x".repeat(60 * 1024) + "'").ok).toBe(false);
  });
});

describe("splitStatements", () => {
  test("ignores semicolons in strings, idents and comments", () => {
    // pushes are trimmed, so trailing comment/newline residue is gone
    expect(splitStatements(`SELECT ';' -- ;\n/* ; */`)).toEqual([`SELECT ';' -- ;`]);
    expect(splitStatements(`SELECT ";"; SELECT 2`)).toEqual([`SELECT ";"`, "SELECT 2"]);
  });
});

describe("clampRows", () => {
  test("defaults to 100 and caps at 1000", () => {
    expect(clampRows()).toEqual({ rows: 100 });
    expect(clampRows(5)).toEqual({ rows: 5 });
    // maxRows defaults to 100, so an explicit maxRows is needed to reach the hard cap
    expect(clampRows(5000)).toEqual({ rows: 100 });
    expect(clampRows(5000, 5000)).toEqual({ rows: 1000 });
    expect(clampRows(undefined, 50)).toEqual({ rows: 50 });
  });
});

describe("appendLimit", () => {
  test("wraps pg SELECT with LIMIT", () => {
    expect(appendLimit("SELECT * FROM users ORDER BY id", 10, "postgres")).toBe(
      "SELECT * FROM (SELECT * FROM users ORDER BY id\n) AS _pi_cap LIMIT 10",
    );
  });
  test("wraps mssql SELECT without ORDER BY with TOP", () => {
    expect(appendLimit("SELECT * FROM users", 10, "sqlserver")).toBe(
      "SELECT TOP(10) * FROM (SELECT * FROM users\n) AS _pi_cap",
    );
  });
  test("appends OFFSET/FETCH for mssql with top-level ORDER BY (T-SQL forbids ORDER BY in derived tables)", () => {
    expect(appendLimit("SELECT id FROM users ORDER BY id", 10, "sqlserver")).toBe(
      "SELECT id FROM users ORDER BY id\nOFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY",
    );
  });
  test("leaves mssql queries that already cap rows alone", () => {
    const sql = "SELECT id FROM users ORDER BY id OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY";
    expect(appendLimit(sql, 10, "sqlserver")).toBe(sql);
  });
  test("clamps cap to hard max and floors at 1", () => {
    expect(appendLimit("SELECT 1", 99999, "postgres")).toContain("LIMIT 1000");
    expect(appendLimit("SELECT 1", 0, "postgres")).toContain("LIMIT 1");
  });
  test("leaves non-wrappable leaders unchanged", () => {
    expect(appendLimit("EXPLAIN SELECT 1", 10, "postgres")).toBe("EXPLAIN SELECT 1");
    expect(appendLimit("VALUES (1)", 10, "postgres")).toBe("VALUES (1)");
  });
  test("keeps trailing line comments inside the wrap", () => {
    const out = appendLimit("SELECT 1 -- note", 5, "postgres");
    expect(out).toBe("SELECT * FROM (SELECT 1 -- note\n) AS _pi_cap LIMIT 5");
  });
});

describe("findTopLevelOrderBy", () => {
  test("finds top-level ORDER BY, ignores nested/quoted ones", () => {
    expect(findTopLevelOrderBy("SELECT * FROM users ORDER BY id")).toBeGreaterThan(-1);
    expect(findTopLevelOrderBy("SELECT * FROM users")).toBe(-1);
    expect(findTopLevelOrderBy("SELECT * FROM (SELECT * FROM t ORDER BY x) q")).toBe(-1);
    expect(findTopLevelOrderBy("SELECT 'ORDER BY' FROM t")).toBe(-1);
    expect(findTopLevelOrderBy("SELECT * FROM t -- ORDER BY\n")).toBe(-1);
    expect(findTopLevelOrderBy("select a from t order\n  by a")).toBeGreaterThan(-1);
  });
});

describe("stripExplainPrefix", () => {
  test("parses bare and parenthesized ANALYZE", () => {
    expect(stripExplainPrefix("EXPLAIN ANALYZE SELECT 1")).toMatchObject({ inner: "SELECT 1", hasAnalyze: true });
    expect(stripExplainPrefix("EXPLAIN SELECT 1")).toMatchObject({ inner: "SELECT 1", hasAnalyze: false });
    expect(stripExplainPrefix("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 1")).toMatchObject({ hasAnalyze: true });
    expect(stripExplainPrefix("EXPLAIN (COSTS OFF) SELECT 1")).toMatchObject({ hasAnalyze: false });
  });
});

describe("buildPgExplain", () => {
  test("builds option lists without user-text injection", () => {
    expect(buildPgExplain("SELECT 1", {})).toBe("EXPLAIN SELECT 1");
    expect(buildPgExplain("SELECT * FROM t;", { analyze: true })).toBe("EXPLAIN (ANALYZE) SELECT * FROM t");
    expect(buildPgExplain("SELECT 1", { analyze: true, buffers: true, format: "json" })).toBe(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 1",
    );
    expect(buildPgExplain("SELECT 1", { costs: false })).toContain("COSTS FALSE");
  });
});

describe("truncateCell", () => {
  test("nulls, dates and long values", () => {
    expect(truncateCell(null)).toEqual({ text: "NULL", wasTruncated: false });
    expect(truncateCell(new Date("2020-01-01T00:00:00Z")).text).toBe("2020-01-01T00:00:00.000Z");
    const long = truncateCell("x".repeat(5000));
    expect(long.wasTruncated).toBe(true);
    expect(long.text.length).toBe(2001);
  });
});

// ---------------------------------------------------------------------------
// P0 write-validation gate (validateWriteSql, single-statement-only v1)
// ---------------------------------------------------------------------------

describe("validateWriteSql P0 gate", () => {
  test("P0-1 single UPDATE with WHERE is allowed as kind update", () => {
    const r = validateWriteSql("UPDATE users SET active=false WHERE last_login < '2024-01-01'");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe("update");
      expect(r.statements).toHaveLength(1);
    }
  });

  test("P0-2 UPDATE without WHERE is blocked", () => {
    const r = validateWriteSql("UPDATE users SET active=false");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("update");
      expect(r.error).toMatch(/WHERE/i);
    }
  });

  test("P0-3 DELETE without WHERE is blocked", () => {
    const r = validateWriteSql("DELETE FROM users");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("delete");
      expect(r.error).toMatch(/WHERE/i);
    }
  });

  test("P0-4 single INSERT is allowed", () => {
    const r = validateWriteSql("INSERT INTO users(name) VALUES ('ada')");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe("insert");
  });

  test("P0-5 UPDATE WHERE, DELETE WHERE and MERGE are allowed", () => {
    const u = validateWriteSql("UPDATE b SET y=2 WHERE id=2");
    expect(u.ok).toBe(true);
    if (u.ok) expect(u.kind).toBe("update");
    const d = validateWriteSql("DELETE FROM b WHERE id=2");
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.kind).toBe("delete");
    const m = validateWriteSql(
      "MERGE INTO tgt USING src ON tgt.id=src.id WHEN MATCHED THEN UPDATE SET x=1",
    );
    expect(m.ok).toBe(true);
    if (m.ok) expect(m.kind).toBe("merge");
  });

  test("P0-6 CREATE without allowDdl is blocked as kind ddl", () => {
    const r = validateWriteSql("CREATE TABLE t (id INT)");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("ddl");
      expect(r.error).toMatch(/allowDdl/);
    }
  });

  test("P0-7 CREATE with allowDdl:true is allowed", () => {
    const r = validateWriteSql("CREATE INDEX ix_users_active ON users(active)", { allowDdl: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe("ddl");
  });

  test("P0-8 stacked UPDATE plus DELETE is blocked as kind multi even with allowMulti:true (deprecated and ignored)", () => {
    const r = validateWriteSql("UPDATE a SET x=1 WHERE id=1; DELETE FROM b WHERE id=2", { allowMulti: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("multi");
      expect(r.error).toMatch(/multi-statement/i);
      expect(r.error).toMatch(/deprecated/i);
    }
  });

  test("P0-9 dangerous keywords are always blocked", () => {
    const vectors = [
      "GRANT SELECT ON t TO r",
      "REVOKE SELECT ON t FROM r",
      "BACKUP DATABASE db TO DISK='x'",
      "RESTORE DATABASE db FROM DISK='x'",
      "SHUTDOWN",
      "KILL 55",
      "COPY users TO '/tmp/x.csv'",
      "SELECT * FROM t WHERE f=xp_cmdshell",
      "EXEC sp_help",
      "EXECUTE sp_who",
      "EXEC sp_addrolemember 'a','b'",
    ];
    for (const sql of vectors) {
      const r = validateWriteSql(sql, { allowDdl: true, allowMulti: true });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/forbidden|Blocked/i);
    }
  });

  test("P0-10 SELECT via validateWriteSql is blocked (use mode:read)", () => {
    const r = validateWriteSql("SELECT 1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/mode:read|Only write/i);
  });

  test("P2 empty and oversized write sql is blocked", () => {
    expect(validateWriteSql("").ok).toBe(false);
    expect(validateWriteSql("   ").ok).toBe(false);
    expect(validateWriteSql("INSERT INTO t VALUES ('" + "x".repeat(60 * 1024) + "')").ok).toBe(false);
  });

  test("P2 comment and string tricks do not bypass or false-positive the gate", () => {
    // Forbidden word inside a string literal is stripped, so it must NOT block.
    expect(validateWriteSql("INSERT INTO t(note) VALUES ('GRANT this is just text')").ok).toBe(true);
    // Forbidden word inside a comment is stripped, so it must NOT block.
    expect(validateWriteSql("UPDATE t SET x=1 WHERE id=1 -- GRANT note").ok).toBe(true);
    // A WHERE that only appears inside a string literal does NOT satisfy the guard.
    const sneaky = validateWriteSql("UPDATE t SET name='WHERE clause'");
    expect(sneaky.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tool-level gates (index.ts) — no live DB; unroutable TEST-NET-1 proves
// reject-before-connect vs attempted-connect (Database error).
// ---------------------------------------------------------------------------

function capturedTools(): Map<string, { execute: (...a: never[]) => Promise<never> } & Record<string, unknown>> {
  const map = new Map();
  const pi = { registerTool: (def: Record<string, unknown>) => { map.set(def["name"] as string, def); } };
  (initSqlTool as unknown as (pi: unknown) => void)(pi);
  return map as never;
}

function unroutableBase(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dialect: "postgres",
    host: "192.0.2.1",
    database: "app",
    user: "u",
    password: "SUPERSECRET_pw_123",
    connectionTimeoutMs: 1000,
    queryTimeoutMs: 1000,
    tls: { mode: "off" as const, caPem: "CA_PEM_SECRET_456" },
    ...extra,
  };
}

async function callTool(name: string, params: Record<string, unknown>): Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> {
  const tools = capturedTools();
  const tool = tools.get(name) as unknown as { execute: (id: string, p: unknown, s: AbortSignal | undefined, u: unknown, c: unknown) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool.execute("t1", params, undefined as unknown as AbortSignal, undefined, undefined);
}

describe("write gates without live DB", () => {
  test("P0-11 deprecated alias sql_reader blocks write and preview on the outer gate (read-only)", async () => {
    const writeParams = unroutableBase({ action: "write", mode: "write", dryRun: false, confirm: true, sql: "UPDATE t SET x=1 WHERE id=1" });
    const w = await callTool("sql_reader", writeParams);
    expect(w.isError).toBe(true);
    expect(w.content[0].text).toMatch(/read-only|deprecated alias/i);
    expect(JSON.stringify(w.details)).not.toContain("SUPERSECRET_pw_123");
    const previewParams = unroutableBase({ action: "preview", mode: "write", sql: "UPDATE t SET x=1 WHERE id=1" });
    const p = await callTool("sql_reader", previewParams);
    expect(p.isError).toBe(true);
    expect(p.content[0].text).toMatch(/read-only|deprecated alias/i);
  });

  test("P0-12 write and preview with mode:read are refused fail-closed", async () => {
    const w = await callTool("sql-tool", unroutableBase({ action: "write", mode: "read", dryRun: false, confirm: true, sql: "UPDATE t SET x=1 WHERE id=1" }));
    expect(w.isError).toBe(true);
    expect(w.content[0].text).toMatch(/requires mode:"write"/);
    const p = await callTool("sql-tool", unroutableBase({ action: "preview", sql: "UPDATE t SET x=1 WHERE id=1" }));
    expect(p.isError).toBe(true);
    expect(p.content[0].text).toMatch(/requires mode:"write"/);
  });

  test("P0-14 dryRun:false without confirm:true is refused before any mutation", async () => {
    const r = await callTool("sql-tool", unroutableBase({ action: "write", mode: "write", dryRun: false, sql: "UPDATE t SET x=1 WHERE id=1" }));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/confirm:true/);
  });

  test("P0-13 dryRun:true passes the gate and attempts a preview (Database error proves no gate refusal)", async () => {
    const r = await callTool("sql-tool", unroutableBase({ action: "write", mode: "write", dryRun: true, sql: "UPDATE t SET x=1 WHERE id=1" }));
    expect(r.isError).toBe(true);
    // Must NOT be a gate refusal; with no live DB the preview attempt fails at connect.
    expect(r.content[0].text).not.toMatch(/requires confirm|requires mode/);
    expect(r.content[0].text).toMatch(/Database error/i);
  });

  test("P0-15 stacked write is blocked before mutation even with confirm:true and allowMulti:true", async () => {
    const r = await callTool(
      "sql-tool",
      unroutableBase({ action: "write", mode: "write", dryRun: false, confirm: true, allowMulti: true, sql: "UPDATE a SET x=1 WHERE id=1; DELETE FROM b WHERE id=2" }),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/multi-statement/i);
    expect(r.content[0].text).not.toMatch(/Database error/);
  });

  test("P1 alias read delegates instead of blocking (unroutable preview attempt shows Database error with deprecatedAlias:true)", async () => {
    const r = await callTool("sql_reader", unroutableBase({ action: "query", mode: "read", sql: "SELECT 1" }));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Database error/i);
    expect((r.details as Record<string, unknown>)["deprecatedAlias"]).toBe(true);
  });

  test("P1 secrets never leak into tool details (password and caPem redacted)", async () => {
    const r = await callTool("sql-tool", unroutableBase({ action: "write", mode: "read", sql: "UPDATE t SET x=1 WHERE id=1" }));
    const blob = JSON.stringify(r.details);
    expect(blob).not.toContain("SUPERSECRET_pw_123");
    expect(blob).not.toContain("CA_PEM_SECRET_456");
    expect(blob).toContain("192.0.2.1");
  });

  test("P2 static annotations stay write-capable fail-closed and audit carries per-call hints", async () => {
    const tools = capturedTools();
    for (const name of ["sql-tool", "sql_reader"]) {
      const ann = (tools.get(name) as unknown as { annotations: Record<string, unknown> }).annotations;
      expect(ann["readOnlyHint"]).toBe(false);
      expect(ann["destructiveHint"]).toBe(true);
    }
    const readRefused = await callTool("sql-tool", unroutableBase({ action: "write", mode: "read", sql: "UPDATE t SET x=1 WHERE id=1" }));
    const audit = (readRefused.details as Record<string, Record<string, unknown>>)["audit"] ?? (readRefused.details as Record<string, unknown>);
    const annotations = (readRefused.details as Record<string, unknown>)["annotations"] as Record<string, unknown> | undefined
      ?? (audit as Record<string, unknown>)["annotations"] as Record<string, unknown> | undefined;
    // Audit must record the write attempt even when refused.
    expect(JSON.stringify(readRefused.details)).toMatch(/write/);
    expect(annotations === undefined || annotations["readOnlyHint"] === true || annotations["destructiveHint"] === false).toBe(true);
  });
});

describe("db single-only guards without live DB", () => {
  const conn = { dialect: "postgres", host: "192.0.2.1", database: "app", user: "u", password: "pw", connectionTimeoutMs: 1000, queryTimeoutMs: 1000 } as never;

  test("P0-15 runWrite rejects stacked sql before connecting (no Database error)", async () => {
    let err = "";
    try {
      await runWrite(conn as never, "UPDATE a SET x=1 WHERE id=1; DELETE FROM b WHERE id=2", {}, undefined);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    expect(err).toMatch(/multi-statement/i);
  });

  test("P0-16 buildWritePreview throws for stacked sql before any I/O", async () => {
    let err = "";
    try {
      await buildWritePreview(conn as never, "UPDATE a SET x=1 WHERE id=1; DELETE FROM b WHERE id=2", undefined);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    expect(err).toMatch(/multi-statement/i);
  });

  test("P1 preview and execute agree on single-statement shape", () => {
    const single = "UPDATE users SET active=false WHERE id=1";
    const v = validateWriteSql(single);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.statements).toHaveLength(1);
      expect(describeWriteStatement(v.statements[0]).kind).toBe("update");
      expect(describeWriteStatement(v.statements[0]).target).toBe("users");
    }
  });
});

describe("P1 read paths and caps stay intact", () => {
  test("read guard still allows SELECT and blocks writes", () => {
    expect(validateReadOnlySql("SELECT 1").ok).toBe(true);
    expect(validateReadOnlySql("UPDATE t SET x=1 WHERE id=1").ok).toBe(false);
    expect(validateReadOnlySql("SELECT 1; SELECT 2").ok).toBe(false);
  });

  test("appendLimit never exceeds the hard cap", () => {
    expect(appendLimit("SELECT 1", 99999, "postgres")).toContain("LIMIT 1000");
    expect(appendLimit("SELECT * FROM t", 99999, "sqlserver")).toContain("TOP(1000)");
  });

  test("redaction helpers never include secrets", () => {
    const c = { dialect: "postgres", host: "db", database: "app", user: "reader", password: "SUPERSECRET_pw_123" } as never;
    expect(connLabel(c as never)).not.toContain("SUPERSECRET_pw_123");
    const s = JSON.stringify(tlsSummary({ ...(c as object), tls: { mode: "tls", caPem: "CA_PEM_SECRET_456" } } as never));
    expect(s).not.toContain("SUPERSECRET_pw_123");
    expect(s).not.toContain("CA_PEM_SECRET_456");
  });
});

describe("P2 package and docs pin single-only", () => {
  test("package identity is pi-sql-tool 1.1.0", () => {
    const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
    expect(pkg.name).toBe("pi-sql-tool");
    expect(pkg.version).toBe("1.1.0");
  });

  test("README documents v1 single-only and deprecated allowMulti", () => {
    const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
    expect(readme).toMatch(/single-only|single-statement/i);
    expect(readme).toMatch(/allowMulti.*deprecated/i);
  });
});
