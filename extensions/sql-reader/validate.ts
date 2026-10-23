/** Read-only guards for the `query` action. Fail closed. */

export const MAX_SQL_BYTES = 50 * 1024;
export const MAX_ROWS_HARD = 1000;
export const MAX_CELL_CHARS = 2000;

const READ_ONLY_LEADERS = ["SELECT", "WITH", "VALUES", "TABLE", "EXPLAIN"];

// Word-boundary patterns checked AFTER stripping string literals,
// quoted identifiers, line comments and block comments.
//
// NOTE: ANALYZE is handled separately (see ANALYZE_RE + stripExplainPrefix):
// it is only allowed as an EXPLAIN option (EXPLAIN ANALYZE / EXPLAIN
// (ANALYZE, ...)). Bare ANALYZE (maintenance) stays blocked.
const FORBIDDEN = [
  /\bINSERT\b/i,
  /\bUPDATE\b/i,
  /\bDELETE\b/i,
  /\bMERGE\b/i,
  /\bUPSERT\b/i,
  /\bCREATE\b/i,
  /\bALTER\b/i,
  /\bDROP\b/i,
  /\bTRUNCATE\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
  /\bCOPY\b/i,
  /\bCALL\b/i,
  /\bEXEC(UTE)?\b/i,
  /\bDECLARE\b/i,
  /\bVACUUM\b/i,
  /\bCLUSTER\b/i,
  /\bREINDEX\b/i,
  /\bCOMMENT\b/i,
  /\bSECURITY\b/i,
  /\bLISTEN\b/i,
  /\bNOTIFY\b/i,
  /\bLOAD\b/i,
  /\bIMPORT\b/i,
  /\bEXPORT\b/i,
  /\bBACKUP\b/i,
  /\bRESTORE\b/i,
  /\bSHUTDOWN\b/i,
  /\bKILL\b/i,
  /\bFOR\s+(UPDATE|SHARE|KEY\s+SHARE|NO\s+KEY\s+UPDATE)\b/i, // locking reads
  /\bxp_/i,
  /\bEXEC(UTE)?\s+sp_/i, // system stored procs (EXEC alone is already blocked above)
  /\bINTO\b/i, // blocks SELECT ... INTO (which creates a table in mssql/pg)
];

function stripLiteralsAndComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    // line comment --
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    // block comment /* */
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    // single-quoted string ('' escape), dollar-quoted (postgres $tag$), double-quoted ident
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      out += " '' ";
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && sql[i] !== '"') i++;
      i++;
      out += " ";
      continue;
    }
    if (c === "$") {
      const m = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        out += " '' ";
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** Split on top-level `;` (string/comment aware). Returns non-empty statements. */
export function splitStatements(sql: string): string[] {
  const stmts: string[] = [];
  let cur = "";
  let i = 0;
  const n = sql.length;
  let inStr = false;
  let inDq = false;
  while (i < n) {
    const c = sql[i];
    if (inDq) {
      cur += c;
      if (c === '"') inDq = false;
      i++;
      continue;
    }
    if (inStr) {
      cur += c;
      if (c === "'" && sql[i + 1] === "'") { cur += "'"; i += 2; continue; }
      if (c === "'") inStr = false;
      i++;
      continue;
    }
    if (c === "'") { inStr = true; cur += c; i++; continue; }
    if (c === '"') { inDq = true; cur += c; i++; continue; }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") { cur += sql[i]; i++; }
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      cur += " ";
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === ";") {
      if (cur.trim()) stmts.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) stmts.push(cur.trim());
  return stmts;
}

const ANALYZE_RE = /\bANALYZE\b/i;

/**
 * Parse an EXPLAIN prefix off an already-stripped (literals/comments removed)
 * statement. Caller must have verified the leader is EXPLAIN.
 *
 * Supports both modern `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) <stmt>` and
 * legacy `EXPLAIN ANALYZE VERBOSE <stmt>` forms.
 *
 * Returns the inner statement plus the raw option text and whether ANALYZE
 * was requested (i.e. the plan executes the query and can be heavy).
 */
export function stripExplainPrefix(stripped: string): { inner: string; optionsText: string; hasAnalyze: boolean } | { error: string } {
  let rest = stripped.trim().replace(/^EXPLAIN\b/i, "").trim();
  if (!rest) return { error: "EXPLAIN requires a statement to explain." };
  let optionsText = "";
  let hasAnalyze = false;
  if (rest.startsWith("(")) {
    let depth = 0;
    let idx = -1;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "(") depth++;
      else if (rest[i] === ")") {
        depth--;
        if (depth === 0) { idx = i; break; }
      }
    }
    if (idx === -1) return { error: "Unbalanced parentheses in EXPLAIN options." };
    optionsText = rest.slice(1, idx);
    hasAnalyze = ANALYZE_RE.test(optionsText);
    const allowed = new Set([
      "ANALYZE", "VERBOSE", "COSTS", "SETTINGS", "BUFFERS", "WAL",
      "TIMING", "SUMMARY", "FORMAT", "TRUE", "FALSE", "ON", "OFF",
      "TEXT", "XML", "JSON", "YAML",
    ]);
    const words = optionsText.split(/[\s,]+/).filter(Boolean);
    if (words.length === 0) return { error: "Empty EXPLAIN option list." };
    for (const w of words) {
      if (/^\d+$/.test(w)) continue;
      if (!allowed.has(w.toUpperCase())) return { error: `Unsupported EXPLAIN option "${w}".` };
    }
    rest = rest.slice(idx + 1).trim();
  } else {
    // Legacy bare form: EXPLAIN [ANALYZE] [VERBOSE] [COSTS ...] <stmt>
    const bareAllowed = new Set(["ANALYZE", "VERBOSE", "COSTS", "SETTINGS", "BUFFERS", "WAL", "TIMING", "SUMMARY"]);
    for (;;) {
      const m = /^(ANALYZE|VERBOSE|COSTS|SETTINGS|BUFFERS|WAL|TIMING|SUMMARY)\b/i.exec(rest);
      if (!m) break;
      if (m[1].toUpperCase() === "ANALYZE") hasAnalyze = true;
      rest = rest.slice(m[0].length).trim();
      const b = /^(TRUE|FALSE|ON|OFF)\b/i.exec(rest);
      if (b) rest = rest.slice(b[0].length).trim();
    }
  }
  return { inner: rest, optionsText, hasAnalyze };
}

export function validateReadOnlySql(sql: string): { ok: true } | { ok: false; error: string } {
  if (!sql || !sql.trim()) return { ok: false, error: "sql must be a non-empty SELECT statement." };
  if (Buffer.byteLength(sql, "utf8") > MAX_SQL_BYTES) {
    return { ok: false, error: `sql exceeds ${MAX_SQL_BYTES} bytes.` };
  }
  const stmts = splitStatements(sql);
  if (stmts.length !== 1) {
    return { ok: false, error: `Only a single statement is allowed (found ${stmts.length}). Send one SELECT at a time.` };
  }
  const stripped = stripLiteralsAndComments(stmts[0]).trim();
  const firstWord = stripped.split(/[\s(]+/, 1)[0]?.toUpperCase() ?? "";
  if (!READ_ONLY_LEADERS.includes(firstWord)) {
    return {
      ok: false,
      error: `Only read-only queries are allowed (must start with ${READ_ONLY_LEADERS.join("/")}, got "${firstWord || "?"}").`,
    };
  }
  // EXPLAIN: ANALYZE is allowed only as an EXPLAIN option. The inner
  // statement must itself be read-only (SELECT/WITH/VALUES/TABLE/EXPLAIN).
  // NOTE: EXPLAIN ANALYZE executes the query (can be heavy); callers should
  // surface queryTimeoutMs for it.
  if (firstWord === "EXPLAIN") {
    const parsed = stripExplainPrefix(stripped);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    if (!parsed.inner) return { ok: false, error: "EXPLAIN requires a statement to explain." };
    const innerFirst = parsed.inner.split(/[\s(]+/, 1)[0]?.toUpperCase() ?? "";
    if (!READ_ONLY_LEADERS.includes(innerFirst)) {
      return {
        ok: false,
        error: `EXPLAIN only supports read-only statements (got "${innerFirst || "?"}").`,
      };
    }
    for (const re of FORBIDDEN) {
      if (re.test(parsed.inner)) {
        return { ok: false, error: `Blocked: query contains forbidden keyword matching ${re.source}. Read-only SELECT/WITH only.` };
      }
    }
    // ANALYZE may appear in the consumed prefix, but nowhere else.
    if (ANALYZE_RE.test(parsed.inner)) {
      return { ok: false, error: "Blocked: query contains forbidden keyword matching \\bANALYZE\\b. ANALYZE is only allowed as an EXPLAIN option." };
    }
    return { ok: true };
  }
  for (const re of FORBIDDEN) {
    if (re.test(stripped)) {
      return { ok: false, error: `Blocked: query contains forbidden keyword matching ${re.source}. Read-only SELECT/WITH only.` };
    }
  }
  if (ANALYZE_RE.test(stripped)) {
    return { ok: false, error: "Blocked: query contains forbidden keyword matching \\bANALYZE\\b. Read-only SELECT/WITH only." };
  }
  return { ok: true };
}

export function clampRows(limit?: number, maxRows?: number): { rows: number } {
  const want = Math.min(limit ?? 100, maxRows ?? 100, MAX_ROWS_HARD);
  return { rows: Math.max(1, Math.floor(want)) };
}

/**
 * Enforce a row cap server-side. `cap` is always an integer, never user text,
 * so there is no injection surface.
 *
 * postgres: SELECT/WITH are wrapped in `SELECT * FROM (…) LIMIT n`
 * (ORDER BY in subqueries is legal). Other leaders (EXPLAIN/VALUES/TABLE)
 * are returned unchanged — wrapping them is syntactically invalid; they rely
 * on the client-side slice as backstop (their outputs are small by nature).
 *
 * sqlserver: T-SQL forbids ORDER BY inside a derived table, so wrapping is
 * only safe when there is no top-level ORDER BY. With one, append
 * `OFFSET 0 ROWS FETCH NEXT n ROWS ONLY` (requires ORDER BY — exact
 * semantics, order preserved). A query that already ends in FETCH is left
 * alone (user already capped; client slice backstops). Anything else gets
 * the `SELECT TOP(n) * FROM (…)` wrap.
 */
export function appendLimit(sql: string, cap: number, dialect: "postgres" | "sqlserver"): string {
  const n = Math.max(1, Math.floor(Math.min(cap, MAX_ROWS_HARD)));
  const stripped = stripLiteralsAndComments(sql);
  const leader = stripped.trim().split(/[\s(]+/, 1)[0]?.toUpperCase() ?? "";
  if (leader !== "SELECT" && leader !== "WITH") return sql;
  const inner = sql.trim().replace(/;+\s*$/, "");
  // The newline before the closing paren terminates any trailing `--` comment.
  if (dialect === "postgres") return `SELECT * FROM (${inner}\n) AS _pi_cap LIMIT ${n}`;
  if (/\bFETCH\s+(FIRST|NEXT)\b/i.test(stripped)) return sql;
  if (findTopLevelOrderBy(sql) >= 0) return `${inner}\nOFFSET 0 ROWS FETCH NEXT ${n} ROWS ONLY`;
  return `SELECT TOP(${n}) * FROM (${inner}\n) AS _pi_cap`;
}

/**
 * Index of the last top-level (paren depth 0) ORDER BY in the original SQL,
 * string/comment aware. -1 when there is none.
 */
export function findTopLevelOrderBy(sql: string): number {
  let depth = 0;
  let last = -1;
  let i = 0;
  const n = sql.length;
  const wordAt = (j: number): string | null => {
    const m = /^[A-Za-z]+/.exec(sql.slice(j));
    return m ? m[0] : null;
  };
  while (i < n) {
    const c = sql[i];
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '"') { i++; while (i < n && sql[i] !== '"') i++; i++; continue; }
    if (c === "-" && sql[i + 1] === "-") { while (i < n && sql[i] !== "\n") i++; continue; }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "$") {
      const m = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        i = end === -1 ? n : end + m[0].length;
        continue;
      }
    }
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const w = wordAt(i);
      if (w && w.toUpperCase() === "ORDER") {
        let j = i + w.length;
        while (j < n && /\s/.test(sql[j])) j++;
        const w2 = /^[A-Za-z]+/.exec(sql.slice(j))?.[0]?.toUpperCase();
        if (w2 === "BY") last = i;
        i += w.length;
        continue;
      }
    }
    i++;
  }
  return last;
}

export function truncateCell(value: unknown): { text: string; wasTruncated: boolean } {
  if (value === null || value === undefined) return { text: "NULL", wasTruncated: false };
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === "object") {
    try { s = JSON.stringify(value); } catch { s = String(value); }
  } else s = String(value);
  if (s.length > MAX_CELL_CHARS) return { text: s.slice(0, MAX_CELL_CHARS) + "…", wasTruncated: true };
  return { text: s, wasTruncated: false };
}
