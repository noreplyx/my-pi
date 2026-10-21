# sql-reader

Read-only SQL Server + Postgres reader for Pi. Single tool `sql_reader` with `action` dispatch.

## Actions

| action | params | result |
|---|---|---|
| `ping` | conn | connectivity, server version, latency |
| `query` | conn + `sql` | columns + rows (cap enforced server-side via LIMIT/TOP wrapper), truncated flag |
| `tables` | conn + optional `schema` | schema/name/type |
| `columns` | conn + `schema?` + `table?` | name/dataType/nullable/default/maxLength/precision/scale |
| `schema` | conn + `schema?` | tables + columns bundled (capped at 200 tables, truncated flag) |
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

`query` allows exactly one statement starting with `SELECT/WITH/VALUES/TABLE/EXPLAIN`;
`INSERT/UPDATE/DELETE/MERGE/CREATE/ALTER/DROP/.../INTO/FOR UPDATE/EXEC sp_/xp_` are blocked.
Row cap (`limit`, default 100, max 1000) is pushed to the server (`LIMIT`/`TOP` wrapper);
`EXPLAIN`/`VALUES`/`TABLE` leaders skip wrapping (invalid syntax) and rely on client slicing.
Cells truncated at 2000 chars. Long queries are cancellable via abort signal.

Results also carry `structuredContent` (declared `outputSchema`) for codemode scripts.

## Tests

`bun test` — unit tests for guards, limit wrapper, TLS matrix, redaction (`validate.test.ts`, `tls.test.ts`).

## Deps

`pg`, `tedious` in local `package.json` (`npm install` in this dir).
