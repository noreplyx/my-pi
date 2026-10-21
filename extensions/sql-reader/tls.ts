/** TLS option normalization for postgres (pg) and SQL Server (tedious). */

export interface TlsOptions {
  /** "off" = plaintext; "tls" = encrypted. Default: "off". */
  mode?: "off" | "tls";
  /** Verify server certificate. Default true when mode=tls. */
  rejectUnauthorized?: boolean;
  /** PEM-encoded CA bundle for self-signed / private CAs. */
  caPem?: string;
  /** Override SNI / hostname verification (postgres `servername`). */
  serverName?: string;
}

export interface ConnParams {
  dialect: "postgres" | "sqlserver";
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  connectionTimeoutMs?: number;
  queryTimeoutMs?: number;
  tls?: TlsOptions;
}

export function defaultPort(dialect: ConnParams["dialect"]): number {
  return dialect === "postgres" ? 5432 : 1433;
}

export function tlsRequested(conn: ConnParams): boolean {
  return (conn.tls?.mode ?? "off") === "tls";
}

function rejectUnauthorized(conn: ConnParams): boolean {
  return conn.tls?.rejectUnauthorized ?? true;
}

/** Build the `ssl` option for `pg` Client. Returns `false` for plaintext. */
export function pgSslOption(conn: ConnParams): false | Record<string, unknown> {
  if (!tlsRequested(conn)) return false;
  const ssl: Record<string, unknown> = { rejectUnauthorized: rejectUnauthorized(conn) };
  if (conn.tls?.caPem) ssl.ca = conn.tls.caPem;
  if (conn.tls?.serverName) ssl.servername = conn.tls.serverName;
  return ssl;
}

/** Tedious `options` fragment: encrypt + trust + CA. */
export function tediousTlsFragment(conn: ConnParams): Record<string, unknown> {
  if (!tlsRequested(conn)) {
    return { encrypt: false, trustServerCertificate: true };
  }
  const fragment: Record<string, unknown> = {
    encrypt: true,
    trustServerCertificate: !rejectUnauthorized(conn),
  };
  if (conn.tls?.caPem) {
    fragment.cryptoCredentialsDetails = { ca: conn.tls.caPem };
  }
  if (conn.tls?.serverName) {
    fragment.serverName = conn.tls.serverName;
  }
  return fragment;
}

/** Human-readable TLS summary for tool results (never includes secrets). */
export function tlsSummary(conn: ConnParams): Record<string, unknown> {
  return {
    requested: tlsRequested(conn) ? "tls" : "off",
    rejectUnauthorized: tlsRequested(conn) ? rejectUnauthorized(conn) : undefined,
    customCa: Boolean(conn.tls?.caPem),
    serverName: conn.tls?.serverName,
  };
}

/** Redacted connection label for logs / UI (no password). */
export function connLabel(conn: ConnParams): string {
  const port = conn.port ?? defaultPort(conn.dialect);
  return `${conn.dialect}://${conn.user}@${conn.host}:${port}/${conn.database}`;
}
