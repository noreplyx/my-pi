/**
 * Pure URL construction and secret-redaction helpers for the `fetch` and `permissions` extensions.
 *
 * Kept free of `permissions` imports so both `extensions/fetch/*` and `extensions/permissions/*`
 * can import from this leaf module without circular dependencies.
 */

const SENSITIVE_HEADER_EXACT = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "api-key",
]);

export const SENSITIVE_KEY_PATTERN =
  /token|secret|password|key|sig|signature|credential|auth|session|jwt|bearer/i;

/**
 * Check whether a header name carries credentials, tokens, or secrets.
 */
export function isSensitiveHeaderName(headerName: string): boolean {
  const lower = headerName.trim().toLowerCase();
  return SENSITIVE_HEADER_EXACT.has(lower) || SENSITIVE_KEY_PATTERN.test(lower);
}

/**
 * Redact a single header value while preserving the authentication scheme prefix if present.
 */
export function redactHeaderValue(headerName: string, headerValue: string): string {
  if (!isSensitiveHeaderName(headerName)) return headerValue;
  const trimmed = headerValue.trim();
  const schemeMatch = trimmed.match(
    /^(Bearer|Basic|Digest|Token|AWS4-HMAC-SHA256|SharedAccessSignature)\s+\S+/i,
  );
  if (schemeMatch) {
    return `${schemeMatch[1]} [REDACTED]`;
  }
  return "[REDACTED]";
}

/**
 * Return a copy of headers with all sensitive values replaced by `[REDACTED]`.
 */
export function redactHeaders(
  headers: Record<string, string> | Headers | undefined | null,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;

  if (headers instanceof Headers) {
    headers.forEach((headerValue, headerName) => {
      result[headerName] = redactHeaderValue(headerName, headerValue);
    });
    return result;
  }

  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (typeof headerValue === "string") {
      result[headerName] = redactHeaderValue(headerName, headerValue);
    } else if (headerValue !== undefined && headerValue !== null) {
      result[headerName] = redactHeaderValue(headerName, String(headerValue));
    }
  }
  return result;
}

/**
 * Redact credentials (`user:pass@`), sensitive query parameter values, and sensitive URL fragments.
 */
export function redactUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username) parsed.username = "[REDACTED]";
    if (parsed.password) parsed.password = "[REDACTED]";

    const queryKeys = Array.from(parsed.searchParams.keys());
    for (const queryKey of queryKeys) {
      if (SENSITIVE_KEY_PATTERN.test(queryKey)) {
        parsed.searchParams.set(queryKey, "[REDACTED]");
      }
    }

    if (parsed.hash && parsed.hash.length > 1) {
      const rawHashBody = parsed.hash.slice(1);
      if (rawHashBody.includes("=")) {
        const redactedHash = rawHashBody.replace(
          /(^|[?&])([^=&#\s]+)=([^&#\s]*)/g,
          (fullMatch, prefix: string, fragmentKey: string) => {
            let decodedKey = fragmentKey;
            try {
              decodedKey = decodeURIComponent(fragmentKey);
            } catch {
              // keep raw fragment key
            }
            return SENSITIVE_KEY_PATTERN.test(decodedKey)
              ? `${prefix}${fragmentKey}=[REDACTED]`
              : fullMatch;
          },
        );
        parsed.hash = `#${redactedHash}`;
      } else if (SENSITIVE_KEY_PATTERN.test(rawHashBody)) {
        parsed.hash = "#[REDACTED]";
      }
    }

    // Restore readable `[REDACTED]` in query/authority/fragment instead of percent-encoded `%5BREDACTED%5D`
    return parsed.toString().replace(/%5BREDACTED%5D/gi, "[REDACTED]");
  } catch {
    // Fallback regex redaction if URL is malformed
    return rawUrl
      .replace(/(\/\/[^/@:\s]+:)([^/@\s]+)(@)/g, "$1[REDACTED]$3")
      .replace(
        /([?&#][^=&#\s]*(?:token|secret|password|key|sig|signature|credential|auth|session|jwt|bearer)[^=&#\s]*=)([^&#\s]*)/gi,
        "$1[REDACTED]",
      );
  }
}

/**
 * Parse `rawUrl`, verify `http:` or `https:` scheme, and merge `query` parameters.
 */
export function buildRequestUrl(
  rawUrl: string,
  query?: Record<string, string | number | boolean>,
): { ok: boolean; url?: URL; error?: string } {
  const trimmed = (rawUrl ?? "").trim();
  if (!trimmed) {
    return { ok: false, error: "URL is required." };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      error: `Invalid URL "${redactUrl(trimmed)}". Provide a full http:// or https:// URL.`,
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      error: `Unsupported URL scheme "${parsed.protocol}". Only http: and https: are allowed.`,
    };
  }

  if (!parsed.hostname) {
    return { ok: false, error: "URL must include a valid hostname." };
  }

  if (query && typeof query === "object") {
    for (const [queryKey, queryValue] of Object.entries(query)) {
      if (queryValue !== undefined && queryValue !== null) {
        parsed.searchParams.set(queryKey, String(queryValue));
      }
    }
  }

  return { ok: true, url: parsed };
}

/**
 * Canonical helper to merge `query` parameters into `rawUrl` and return a secret-redacted URL string.
 */
export function resolveRedactedRequestUrl(rawUrl: unknown, query?: unknown): string {
  if (typeof rawUrl !== "string" || !rawUrl) return "";
  const queryRecord =
    typeof query === "object" && query !== null && !Array.isArray(query)
      ? (query as Record<string, string | number | boolean>)
      : undefined;
  const built = buildRequestUrl(rawUrl, queryRecord);
  return built.ok && built.url ? redactUrl(built.url.toString()) : redactUrl(rawUrl);
}

/**
 * Produce a secret-safe clone of raw fetch input arguments for permission evaluation,
 * audit logging, and UI display.
 */
export function redactFetchArgsSummary(input: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "method" && typeof value === "string") {
      copy.method = value.trim().toUpperCase();
      continue;
    }
    if (key === "url" && typeof value === "string") {
      copy.url = resolveRedactedRequestUrl(value, input.query);
      continue;
    }
    if (key === "headers" && typeof value === "object" && value !== null && !Array.isArray(value)) {
      copy.headers = redactHeaders(value as Record<string, string>);
      continue;
    }
    if (key === "query" && typeof value === "object" && value !== null && !Array.isArray(value)) {
      const redactedQuery: Record<string, unknown> = {};
      for (const [queryKey, queryValue] of Object.entries(value as Record<string, unknown>)) {
        redactedQuery[queryKey] = SENSITIVE_KEY_PATTERN.test(queryKey) ? "[REDACTED]" : queryValue;
      }
      copy.query = redactedQuery;
      continue;
    }
    if (key === "tls" && typeof value === "object" && value !== null && !Array.isArray(value)) {
      const tlsConfig = value as Record<string, unknown>;
      copy.tls = {
        ...tlsConfig,
        ...(tlsConfig.caPem ? { caPem: "[REDACTED]" } : {}),
      };
      continue;
    }
    if (key === "form" && typeof value === "object" && value !== null && !Array.isArray(value)) {
      const redactedForm: Record<string, unknown> = {};
      for (const [formKey, formValue] of Object.entries(value as Record<string, unknown>)) {
        redactedForm[formKey] = SENSITIVE_KEY_PATTERN.test(formKey) ? "[REDACTED]" : formValue;
      }
      copy.form = redactedForm;
      continue;
    }
    copy[key] = value;
  }
  return copy;
}
