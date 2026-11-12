/**
 * Shared TypeBox schemas and TypeScript contracts for the `safe-fetch` tool extension.
 */

import { type Static, Type } from "typebox";

export const HTTP_METHODS = ["GET", "HEAD", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const RESPONSE_FORMATS = ["auto", "json", "markdown", "text", "raw", "base64"] as const;
export type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

export const DEFAULT_TIMEOUT_MS = 15_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 120_000;

export const DEFAULT_MAX_REDIRECTS = 5;
export const MAX_ALLOWED_REDIRECTS = 20;

export const DEFAULT_MAX_BYTES = 5_242_880; // 5 MiB
export const MIN_MAX_BYTES = 1_024; // 1 KiB
export const MAX_ALLOWED_BYTES = 20_971_520; // 20 MiB
export const MAX_IMAGE_INLINE_BYTES = 10_485_760; // 10 MiB

export const HttpMethodSchema = Type.Union(
  [
    Type.Literal("GET"),
    Type.Literal("HEAD"),
    Type.Literal("OPTIONS"),
  ],
  {
    description: 'HTTP request method ("GET", "HEAD", "OPTIONS"). Default: "GET".',
    default: "GET",
  },
);

export const ResponseFormatSchema = Type.Union(
  [
    Type.Literal("auto"),
    Type.Literal("json"),
    Type.Literal("markdown"),
    Type.Literal("text"),
    Type.Literal("raw"),
    Type.Literal("base64"),
  ],
  {
    description:
      'Response formatting mode: "auto" (JSON pretty-printed, HTML converted to Markdown, images returned as image blocks, text as UTF-8, other binary saved to temp file), "json", "markdown", "text", "raw", or "base64". Default: "auto".',
    default: "auto",
  },
);

export const FetchTlsOptionsSchema = Type.Object(
  {
    rejectUnauthorized: Type.Optional(
      Type.Boolean({
        description: "Verify server TLS certificate (default true). Set false only for trusted self-signed dev endpoints.",
        default: true,
      }),
    ),
    caPem: Type.Optional(
      Type.String({
        description: "PEM-encoded CA certificate bundle for private or internal CAs (per-call only, never logged).",
      }),
    ),
    serverName: Type.Optional(
      Type.String({
        description: "SNI / TLS hostname verification override.",
      }),
    ),
  },
  { description: "Optional TLS verification settings for HTTPS requests." },
);

export type FetchTlsOptions = Static<typeof FetchTlsOptionsSchema>;

export interface TlsSummary {
  requested: "tls" | "off";
  rejectUnauthorized?: boolean;
  customCa: boolean;
  serverName?: string;
}

export const FetchParams = Type.Object({
  url: Type.String({
    description: "Target http:// or https:// URL to fetch.",
  }),
  method: Type.Optional(HttpMethodSchema),
  query: Type.Optional(
    Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]), {
      description: "Optional query string parameters merged into the URL search parameters.",
    }),
  ),
  headers: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        "Optional custom HTTP request headers. Sensitive headers (Authorization, Cookie, X-Api-Key, tokens/secrets) are automatically redacted in all tool outputs and logs.",
    }),
  ),
  body: Type.Optional(
    Type.String({
      description: "Raw string request body (mutually exclusive with `json` and `form`; NOT allowed for safe-fetch — any value is rejected at runtime).",
    }),
  ),
  json: Type.Optional(
    Type.Unknown({
      description:
        "JSON request payload (mutually exclusive with `body` and `form`; NOT allowed for safe-fetch — any value is rejected at runtime).",
    }),
  ),
  form: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        "URL-encoded form fields (mutually exclusive with `body` and `json`; NOT allowed for safe-fetch — any value is rejected at runtime).",
    }),
  ),
  format: Type.Optional(ResponseFormatSchema),
  timeoutMs: Type.Optional(
    Type.Integer({
      description: "Request timeout in milliseconds (1000–120000, default 15000).",
      minimum: MIN_TIMEOUT_MS,
      maximum: MAX_TIMEOUT_MS,
      default: DEFAULT_TIMEOUT_MS,
    }),
  ),
  followRedirects: Type.Optional(
    Type.Boolean({
      description: "Automatically follow HTTP 301/302/303/307/308 redirects with per-hop SSRF validation (default true).",
      default: true,
    }),
  ),
  maxRedirects: Type.Optional(
    Type.Integer({
      description: "Maximum redirect hops to follow when followRedirects is true (0–20, default 5).",
      minimum: 0,
      maximum: MAX_ALLOWED_REDIRECTS,
      default: DEFAULT_MAX_REDIRECTS,
    }),
  ),
  maxBytes: Type.Optional(
    Type.Integer({
      description: "Maximum response body bytes read from the stream (1024–20971520, default 5242880 / 5 MiB).",
      minimum: MIN_MAX_BYTES,
      maximum: MAX_ALLOWED_BYTES,
      default: DEFAULT_MAX_BYTES,
    }),
  ),
  allowPrivateNetwork: Type.Optional(
    Type.Boolean({
      description:
        "Explicit opt-in required to reach localhost, loopback (127.0.0.0/8, ::1), RFC1918 private networks (10/8, 172.16/12, 192.168/16), or internal hostnames (.local, .internal). Cloud metadata endpoints (169.254.169.254, metadata.google.internal, etc.) are unconditionally blocked even when true. Default: false.",
      default: false,
    }),
  ),
  tls: Type.Optional(FetchTlsOptionsSchema),
});

export type FetchInputParams = Static<typeof FetchParams>;

export const FetchOutputSchema = Type.Object(
  {
    status: Type.Optional(Type.Integer()),
    statusText: Type.Optional(Type.String()),
    ok: Type.Optional(Type.Boolean()),
    method: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    finalUrl: Type.Optional(Type.String()),
    redirected: Type.Optional(Type.Boolean()),
    redirectCount: Type.Optional(Type.Integer()),
    redirectChain: Type.Optional(Type.Array(Type.String())),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    requestHeaders: Type.Optional(Type.Record(Type.String(), Type.String())),
    contentType: Type.Optional(Type.String()),
    byteLength: Type.Optional(Type.Integer()),
    format: Type.Optional(Type.String()),
    body: Type.Optional(Type.String()),
    json: Type.Optional(Type.Any()),
    image: Type.Optional(
      Type.Object({
        data: Type.String(),
        mimeType: Type.String(),
      }),
    ),
    truncated: Type.Optional(Type.Boolean()),
    fullOutputPath: Type.Optional(Type.String()),
    elapsedMs: Type.Optional(Type.Integer()),
    tls: Type.Optional(
      Type.Object(
        {
          requested: Type.Union([Type.Literal("tls"), Type.Literal("off")]),
          rejectUnauthorized: Type.Optional(Type.Boolean()),
          customCa: Type.Boolean(),
          serverName: Type.Optional(Type.String()),
        },
        { additionalProperties: true },
      ),
    ),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export type FetchStructuredOutput = Static<typeof FetchOutputSchema>;

export interface FetchDetails extends FetchStructuredOutput {
  outputLines?: number;
  totalLines?: number;
  outputBytes?: number;
  totalBytes?: number;
  streamTruncated?: boolean;
}
