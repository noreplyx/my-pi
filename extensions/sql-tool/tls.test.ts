import { describe, expect, test } from "bun:test";
import {
  connLabel,
  defaultPort,
  pgSslOption,
  tediousTlsFragment,
  tlsRequested,
  tlsSummary,
  type ConnParams,
} from "./tls.ts";

const base: ConnParams = { dialect: "postgres", host: "db", database: "app", user: "reader", password: "s3cr3t" };

describe("ports and labels", () => {
  test("default ports", () => {
    expect(defaultPort("postgres")).toBe(5432);
    expect(defaultPort("sqlserver")).toBe(1433);
  });
  test("connLabel never contains the password", () => {
    const label = connLabel(base);
    expect(label).toBe("postgres://reader@db:5432/app");
    expect(label).not.toContain("s3cr3t");
    expect(connLabel({ ...base, dialect: "sqlserver", port: 1434 })).toBe(
      "sqlserver://reader@db:1434/app",
    );
  });
});

describe("tlsRequested", () => {
  test("defaults to off", () => {
    expect(tlsRequested(base)).toBe(false);
    expect(tlsRequested({ ...base, tls: { mode: "tls" } })).toBe(true);
  });
});

describe("pgSslOption", () => {
  test("plaintext", () => {
    expect(pgSslOption(base)).toBe(false);
  });
  test("tls defaults to verified", () => {
    expect(pgSslOption({ ...base, tls: { mode: "tls" } })).toEqual({ rejectUnauthorized: true });
  });
  test("tls insecure + ca + servername", () => {
    expect(
      pgSslOption({ ...base, tls: { mode: "tls", rejectUnauthorized: false, caPem: "PEM", serverName: "db.internal" } }),
    ).toEqual({ rejectUnauthorized: false, ca: "PEM", servername: "db.internal" });
  });
});

describe("tediousTlsFragment", () => {
  const ms: ConnParams = { ...base, dialect: "sqlserver" };
  test("plaintext", () => {
    expect(tediousTlsFragment(ms)).toEqual({ encrypt: false, trustServerCertificate: true });
  });
  test("tls verified", () => {
    expect(tediousTlsFragment({ ...ms, tls: { mode: "tls" } })).toEqual({
      encrypt: true,
      trustServerCertificate: false,
    });
  });
  test("tls insecure + ca + servername", () => {
    expect(
      tediousTlsFragment({ ...ms, tls: { mode: "tls", rejectUnauthorized: false, caPem: "PEM", serverName: "mssql.internal" } }),
    ).toEqual({
      encrypt: true,
      trustServerCertificate: true,
      cryptoCredentialsDetails: { ca: "PEM" },
      serverName: "mssql.internal",
    });
  });
});

describe("tlsSummary", () => {
  test("contains no secrets", () => {
    for (const conn of [base, { ...base, tls: { mode: "tls" as const, caPem: "PEM", serverName: "x" } }]) {
      const s = JSON.stringify(tlsSummary(conn));
      expect(s).not.toContain("s3cr3t");
      expect(s).not.toContain("PEM");
    }
    expect(tlsSummary(base)).toMatchObject({ requested: "off" });
  });
});
