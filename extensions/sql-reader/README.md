# sql-reader

Read-only SQL Server + Postgres reader for Pi. Single tool `sql_reader` with `action` dispatch.

## Actions

| action | params | result |
|---|---|---|
| `ping` | conn | connectivity, server version, latency |
| `query` | conn + `sql` | columns + rows (cap enforced server-side via LIMIT/TOP wrapper), truncated flag. `EXPLAIN…` allowed incl. `EXPLAIN ANALYZE` / `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` |
| `plan` | conn + `sql` + planner opts | query plan: estimated by default, actual when `analyze:true` (executes). Returns `planText` (+ `planJson` for pg `FORMAT JSON`), `executed`, `truncated` |
| `tables` | conn + optional `schema` | schema/name/type |
| `columns` | conn + `schema?` + `table?` | name/dataType/nullable/default/maxLength/precision/scale |
| `indexes` | conn + `schema?` + `table?` | schema/table/name/isUnique/isPrimary/isUniqueConstraint/type/columns/includedColumns/predicate/definition |
| `schema` | conn + `schema?` | tables + columns + indexes bundled (capped at 200 tables, truncated flag; `indexCount`) |
| `datatypes` | conn | distinct types + column/table counts |

## Connection (per call, never persisted)

`dialect` (`postgres`|`sqlserver`), `host`, `port?` (5432/1433), `database`, `user`, `password`,
`connectionTimeoutMs?`, `queryTimeoutMs?`, `tls?`.

## TLS

- `tls: { mode: "tls" }` → encrypted, cert verified (pg `ssl`, tedious `encrypt:true`).
- `rejectUnauthorized: false` → trust self-signed (dev only).
- `caPem` → private CA bundle. `serverName` → SNI override.
- Omit `tls` or `mode:"off"` → plaintext (mssql `encrypt:false`, pg `ssl:false`).

## Read-only guard

`query`/`plan` allow exactly one statement starting with `SELECT/WITH/VALUES/TABLE/EXPLAIN`;
`INSERT/UPDATE/DELETE/MERGE/CREATE/ALTER/DROP/.../INTO/FOR UPDATE/EXEC sp_/xp_` are blocked.
`ANALYZE` is blocked except as an `EXPLAIN` option (`EXPLAIN ANALYZE…`, `EXPLAIN (ANALYZE, …)…`);
bare `ANALYZE`/`VACUUM ANALYZE` stay blocked and the `EXPLAIN` inner statement must itself be read-only.
Row cap (`limit`, default 100, max 1000) is pushed to the server (`LIMIT`/`TOP` wrapper);
`EXPLAIN`/`VALUES`/`TABLE` leaders skip wrapping (invalid syntax) and rely on client slicing.
Cells truncated at 2000 chars. Long queries are cancellable via abort signal.

## Query plans (`plan` action + `EXPLAIN` passthrough)

- Postgres: `plan` builds `EXPLAIN [(options)] <sql>` from structured opts
  (`analyze`, `verbose`, `costs`, `buffers`, `timing`, `summary`, `settings`, `wal`, `format: text|json|xml|yaml`).
  `format: "json"` also returns parsed `planJson`. Passing an `EXPLAIN…` statement directly
  (via `query` or `plan.sql`) runs it verbatim so any option set works.
- SQL Server: `plan` uses session `SET` wrappers on one dedicated per-call connection
  (always closed, `SET … OFF` in `finally`). `analyze:false` (default) = estimated plan
  (`SHOWPLAN_XML`, does not execute; `planFormat: xml|all|text` selects the shape).
  `analyze:true` = actual plan (`STATISTICS XML`, executes the query). `EXPLAIN…` text is
  postgres-only and rejected for `sqlserver`.
- `analyze:true` / `EXPLAIN ANALYZE` execute the `SELECT` — can be slow on large tables.
  Bound with `queryTimeoutMs`. Plans are capped at 100k chars in `planText`
  (`truncated` flag; display preview capped at 12k).

Results also carry `structuredContent` (declared `outputSchema`) for codemode scripts.

## Tests

`bun test` — unit tests for guards, limit wrapper, TLS matrix, redaction (`validate.test.ts`, `tls.test.ts`).

## Deps

`pg`, `tedious` in local `package.json` (`npm install` in this dir).
