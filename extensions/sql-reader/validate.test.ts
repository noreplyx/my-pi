import { describe, expect, test } from "bun:test";
import { buildPgExplain } from "./db.ts";
import {
  appendLimit,
  clampRows,
  findTopLevelOrderBy,
  splitStatements,
  stripExplainPrefix,
  truncateCell,
  validateReadOnlySql,
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
