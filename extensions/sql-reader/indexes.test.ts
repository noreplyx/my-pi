import { describe, expect, test } from "bun:test";
import { buildMssqlIndexesQuery, buildPgIndexesQuery, formatIndexRow } from "./db.ts";

describe("buildPgIndexesQuery", () => {
  test("schema-only uses $1 and orders by table,index", () => {
    const q = buildPgIndexesQuery("public");
    expect(q.values).toEqual(["public"]);
    expect(q.text).toContain('s.nspname = $1');
    expect(q.text).toContain("ORDER BY 2, 3");
    expect(q.text).toContain('"isUnique"');
    expect(q.text).toContain('"definition"');
  });
  test("table filter appends $2", () => {
    const q = buildPgIndexesQuery("public", "users");
    expect(q.values).toEqual(["public", "users"]);
    expect(q.text).toContain("t.relname = $2");
  });
});

describe("buildMssqlIndexesQuery", () => {
  test("schema-only filters heaps out", () => {
    const q = buildMssqlIndexesQuery("dbo");
    expect(q.params).toEqual([{ name: "schema", value: "dbo" }]);
    expect(q.text).toContain("s.name = @schema");
    expect(q.text).toContain("i.index_id > 0");
    expect(q.text).toContain('"includedColumns"');
  });
  test("table filter appends @table", () => {
    const q = buildMssqlIndexesQuery("dbo", "users");
    expect(q.params).toEqual([
      { name: "schema", value: "dbo" },
      { name: "table", value: "users" },
    ]);
    expect(q.text).toContain("t.name = @table");
  });
});

describe("formatIndexRow", () => {
  test("primary + type + columns", () => {
    expect(
      formatIndexRow({ name: "PK_users", isPrimary: true, isUnique: true, type: "btree", columns: "id" }),
    ).toBe("  IDX PK_users (primary, btree) (id)");
  });
  test("unique-constraint preferred over plain unique", () => {
    expect(
      formatIndexRow({ name: "UQ_email", isUnique: true, isUniqueConstraint: true, type: "btree", columns: "email" }),
    ).toContain("unique-constraint");
  });
  test("partial index appends predicate; expression index without columns", () => {
    expect(
      formatIndexRow({ name: "IX_active", type: "btree", columns: null, predicate: "active = true" }),
    ).toBe("  IDX IX_active (btree)  WHERE active = true");
  });
});
