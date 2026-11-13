# sql-tool

Postgres + SQL Server reader/writer for Pi. Canonical tool `sql-tool` (label "SQL Tool") with `action` dispatch.

> Rename note: `pi-sql-reader` / `sql_reader` → `pi-sql-tool` / `sql-tool`.
> `sql_reader` remains as a thin deprecated alias shim delegating to the same
> execute (details include `deprecatedAlias:true`). Prefer `sql-tool`.

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
| `write` | conn + `sql` + write gate | executes INSERT/UPDATE/DELETE/MERGE (DDL with `allowDdl`). Returns `affectedRows`, optional rows, `dryRun`, `executed` |
| `preview` | conn + `sql` | no-mutation write plan for the single statement (pg `EXPLAIN`, mssql `SHOWPLAN_XML+NOEXEC`). Returns `previewText`/`planText` (+ `details.statements`), `dryRun:true`, `executed:false` |

## Connection (per call, never persisted)

`dialect` (`postgres`|`sqlserver`), `host`, `port?` (5432/1433), `database`, `user`, `password`,
`connectionTimeoutMs?`, `queryTimeoutMs?`, `tls?`. Password/`caPem` are never logged.

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

## Write gate

`mode` defaults to `read`. `write`/`preview` require `mode:"write"` (fail-closed otherwise).

| `dryRun` | `confirm` | result |
|---|---|---|
| `true` (default) | any | preview only via `buildWritePreview` — plans the single statement, no mutation |
| `false` | `false`/unset (default) | fail-closed error (must opt in) |
| `false` | `true` | execute via `runWrite` (transaction, `maxAffectedRows` rollback) |

Defaults: `dryRun:true`, `confirm:false`, `allowDdl:false`, `allowMulti:false (deprecated/ignored in v1 single-only; multi-statement blocked)`, `maxAffectedRows:100`, `returnRows:true`.

Write validation (`validateWriteSql`, `validateReadOnlySql` untouched):
single INSERT/UPDATE/DELETE/MERGE by default; DDL CREATE/ALTER/DROP/TRUNCATE only with
`allowDdl:true`; multi-statement always blocked in v1 (allowMulti deprecated/ignored);
always blocks GRANT/REVOKE/SHUTDOWN/KILL/BACKUP/RESTORE/`xp_`/`sp_add*`/COPY/EXEC `sp_`/`xp_`;
UPDATE/DELETE require WHERE.

Execution (`db.ts`, `appName: pi-sql-tool`, `runQuery`/list paths unchanged):
preview = pg `EXPLAIN` / mssql `SHOWPLAN_XML+NOEXEC` for the single statement on a dedicated connection
(always closed, `SET…OFF` in `finally`); execute = transactional `runWrite` for the single statement with
`maxAffectedRows` rollback/error, abort-signal support, always close.

Dynamic annotations (per call, in `details.audit.annotations`):
`readOnlyHint=(mode==read)`, `destructiveHint=(mode==write)`, `idempotentHint=false` on write.
Static registration is write-capable (fail-closed: `readOnlyHint:false, destructiveHint:true`).

`structuredContent`/`details` carry `affectedRows`/`preview`/`previewText`/`dryRun`/`audit`; never password/`caPem`.

## Examples

Dry-run (default, no mutation):

```json
{ "action": "preview", "mode": "write", "dialect": "postgres", "host": "db", "database": "app", "user": "u", "password": "…", "sql": "UPDATE users SET active=false WHERE last_login < '2024-01-01'" }
```

Confirmed single write:

```json
{ "action": "write", "mode": "write", "dryRun": false, "confirm": true, "dialect": "postgres", "host": "db", "database": "app", "user": "u", "password": "…", "sql": "UPDATE users SET active=false WHERE last_login < '2024-01-01'" }
```

Single-statement retry guidance (v1 blocks multi-statement — send single statements, retry one at a time):

```json
{ "action": "write", "mode": "write", "dryRun": false, "confirm": true, "dialect": "sqlserver", "host": "db", "database": "app", "user": "u", "password": "…", "sql": "UPDATE b SET y=2 WHERE id=2" }
```

DDL with opt-in (`allowDdl`):

```json
{ "action": "write", "mode": "write", "dryRun": false, "confirm": true, "allowDdl": true, "dialect": "postgres", "host": "db", "database": "app", "user": "u", "password": "…", "sql": "CREATE INDEX ix_users_active ON users(active) WHERE active" }
```

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
