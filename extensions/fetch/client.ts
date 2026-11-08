/**
 * HTTP execution client with payload serialization, TLS configuration,
 * manual redirect loop with per-hop SSRF validation, and streaming byte cap.
 */

import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { Readable } from "node:stream";
import * as zlib from "node:zlib";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type DnsLookupFunction,
  ensureFetchAuthorized,
  isMutatingMethod,
  redactHeaders,
  redactUrl,
  sanitizeHeadersForRedirect,
  validateTargetUrlAndResolve,
} from "./security.ts";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  type FetchInputParams,
  type FetchTlsOptions,
  HTTP_METHODS,
  type HttpMethod,
  MAX_ALLOWED_BYTES,
  MAX_ALLOWED_REDIRECTS,
  MAX_TIMEOUT_MS,
  MIN_MAX_BYTES,
  MIN_TIMEOUT_MS,
  type TlsSummary,
} from "./types.ts";

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

export interface PreparedRequestPayload {
  ok: boolean;
  body?: string;
  headers: Record<string, string>;
  error?: string;
}

function hasHeaderCaseInsensitive(headers: Record<string, string>, targetName: string): boolean {
  const lower = targetName.toLowerCase();
  return Object.keys(headers).some((headerName) => headerName.toLowerCase() === lower);
}

function deleteHeaderCaseInsensitive(headers: Record<string, string>, targetName: string): void {
  const lower = targetName.toLowerCase();
  for (const headerName of Object.keys(headers)) {
    if (headerName.toLowerCase() === lower) {
      delete headers[headerName];
    }
  }
}

/**
 * Normalize and validate the HTTP method.
 */
export function normalizeHttpMethod(rawMethod?: string): { ok: boolean; method?: HttpMethod; error?: string } {
  const upper = (rawMethod ?? "GET").trim().toUpperCase();
  if ((HTTP_METHODS as readonly string[]).includes(upper)) {
    return { ok: true, method: upper as HttpMethod };
  }
  return {
    ok: false,
    error: `Unsupported HTTP method "${rawMethod}". Supported methods: ${HTTP_METHODS.join(", ")}.`,
  };
}

/**
 * Validate and serialize request payload (`body`, `json`, or `form`) and set default `Content-Type` header.
 */
export function prepareRequestPayload(
  method: HttpMethod,
  params: Pick<FetchInputParams, "body" | "json" | "form" | "headers">,
): PreparedRequestPayload {
  const headers: Record<string, string> = {};
  if (params.headers && typeof params.headers === "object") {
    for (const [key, value] of Object.entries(params.headers)) {
      if (value !== undefined && value !== null) {
        headers[key] = String(value);
      }
    }
  }

  if (!hasHeaderCaseInsensitive(headers, "user-agent")) {
    headers["User-Agent"] = "pi-fetch/1.0";
  }

  const hasBody = params.body !== undefined;
  const hasJson = params.json !== undefined;
  const hasForm = params.form !== undefined;
  const payloadCount = (hasBody ? 1 : 0) + (hasJson ? 1 : 0) + (hasForm ? 1 : 0);

  if (payloadCount > 1) {
    return {
      ok: false,
      headers,
      error: "Conflicting request payloads: specify at most one of `body`, `json`, or `form`.",
    };
  }

  if (payloadCount > 0 && (method === "GET" || method === "HEAD")) {
    return {
      ok: false,
      headers,
      error: `HTTP ${method} requests cannot include a request body (\`body\`, \`json\`, or \`form\`). Use POST, PUT, PATCH, DELETE, or OPTIONS instead.`,
    };
  }

  if (hasJson) {
    let serialized: string;
    try {
      serialized = JSON.stringify(params.json);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        headers,
        error: `Failed to serialize \`json\` payload: ${msg}`,
      };
    }
    if (!hasHeaderCaseInsensitive(headers, "content-type")) {
      headers["Content-Type"] = "application/json; charset=utf-8";
    }
    return { ok: true, body: serialized, headers };
  }

  if (hasForm) {
    if (typeof params.form !== "object" || params.form === null || Array.isArray(params.form)) {
      return {
        ok: false,
        headers,
        error: "`form` payload must be a key-value object of string fields.",
      };
    }
    const searchParams = new URLSearchParams();
    for (const [formFieldKey, formFieldValue] of Object.entries(params.form)) {
      if (formFieldValue !== undefined && formFieldValue !== null) {
        searchParams.set(formFieldKey, String(formFieldValue));
      }
    }
    if (!hasHeaderCaseInsensitive(headers, "content-type")) {
      headers["Content-Type"] = "application/x-www-form-urlencoded; charset=utf-8";
    }
    return { ok: true, body: searchParams.toString(), headers };
  }

  if (hasBody) {
    return { ok: true, body: String(params.body), headers };
  }

  return { ok: true, body: undefined, headers };
}

/**
 * Produce a secret-free TLS summary for `details` and `structuredContent` (mirrors `sql-reader/tls.ts`).
 */
export function tlsSummary(urlProtocol: string, tls?: FetchTlsOptions): TlsSummary {
  const isHttps = urlProtocol === "https:";
  return {
    requested: isHttps ? "tls" : "off",
    rejectUnauthorized: isHttps ? (tls?.rejectUnauthorized ?? true) : undefined,
    customCa: Boolean(tls?.caPem),
    serverName: tls?.serverName,
  };
}

/**
 * Build runtime `fetch` TLS options for Bun (`tls`) when custom TLS parameters are specified.
 */
export function buildTlsOptions(
  urlProtocol: string,
  tls?: FetchTlsOptions,
): Record<string, unknown> {
  if (urlProtocol !== "https:" || !tls) return {};
  const hasCustomOptions =
    tls.rejectUnauthorized !== undefined || Boolean(tls.caPem) || Boolean(tls.serverName);
  if (!hasCustomOptions) return {};

  const bunTls: Record<string, unknown> = {
    rejectUnauthorized: tls.rejectUnauthorized ?? true,
  };
  if (tls.caPem) {
    bunTls.ca = tls.caPem;
  }
  if (tls.serverName) {
    bunTls.servername = tls.serverName;
  }
  return { tls: bunTls };
}

/**
 * Create a custom `net.LookupFunction` that strictly returns pre-validated IP addresses
 * from `validateTargetUrlAndResolve`, eliminating DNS rebinding TOCTOU between validation and connect.
 */
function createPinnedLookup(resolvedAddresses: string[]) {
  return (
    _hostname: string,
    optionsOrCallback:
      | { family?: number | string; all?: boolean }
      | number
      | ((
          err: NodeJS.ErrnoException | null,
          address: string | Array<{ address: string; family: number }>,
          family?: number,
        ) => void),
    maybeCallback?: (
      err: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ): void => {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    if (!callback) return;

    const lookupOptions =
      typeof optionsOrCallback === "object" && optionsOrCallback !== null
        ? optionsOrCallback
        : typeof optionsOrCallback === "number"
          ? { family: optionsOrCallback }
          : {};

    const validEntries = resolvedAddresses
      .map((rawAddress) => {
        const cleanAddress = rawAddress
          .replace(/^\[|\]$/g, "")
          .split(/%25|%/i)[0]
          .trim();
        const family = net.isIP(cleanAddress);
        return family === 4 || family === 6 ? { address: cleanAddress, family } : null;
      })
      .filter((entry): entry is { address: string; family: number } => entry !== null);

    if (validEntries.length === 0) {
      const lookupErr = new Error(
        "No validated DNS addresses available for pinned connection.",
      ) as NodeJS.ErrnoException;
      lookupErr.code = "ENOTFOUND";
      queueMicrotask(() => callback(lookupErr, ""));
      return;
    }

    const requestedFamily =
      lookupOptions.family === 4 || lookupOptions.family === "IPv4"
        ? 4
        : lookupOptions.family === 6 || lookupOptions.family === "IPv6"
          ? 6
          : 0;

    const matchingFamilyEntries =
      requestedFamily !== 0
        ? validEntries.filter((entry) => entry.family === requestedFamily)
        : validEntries;

    const selectedEntries =
      matchingFamilyEntries.length > 0 ? matchingFamilyEntries : validEntries;

    if (lookupOptions.all) {
      queueMicrotask(() => callback(null, selectedEntries));
    } else {
      const primaryEntry = selectedEntries[0];
      queueMicrotask(() => callback(null, primaryEntry.address, primaryEntry.family));
    }
  };
}

/**
 * Execute an HTTP or HTTPS request using `node:http` / `node:https` with a pinned DNS `lookup`
 * callback (preventing DNS rebinding TOCTOU), preserving `Host` header and TLS `servername` SNI,
 * and transparently decompressing `gzip`, `deflate`, and `br` response streams.
 */
function executePinnedHttpRequest(
  urlStr: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    tls?: FetchTlsOptions;
    resolvedAddresses?: string[];
  },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlStr);
    const isHttps = parsedUrl.protocol === "https:";
    const rawHostname = parsedUrl.hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "")
      .split(/%25|%/i)[0]
      .trim();

    const requestHeaders: Record<string, string> = { ...init.headers };
    if (!hasHeaderCaseInsensitive(requestHeaders, "accept-encoding")) {
      requestHeaders["Accept-Encoding"] = "gzip, deflate, br";
    }

    const pinnedAddresses = init.resolvedAddresses ?? [];
    const lookupOption =
      pinnedAddresses.length > 0 && net.isIP(rawHostname) === 0
        ? { lookup: createPinnedLookup(pinnedAddresses) }
        : {};

    const defaultServerName = net.isIP(rawHostname) === 0 ? rawHostname : undefined;
    const effectiveServerName = init.tls?.serverName ?? defaultServerName;

    const requestOptions: https.RequestOptions = {
      method: init.method,
      headers: requestHeaders,
      signal: init.signal,
      ...lookupOption,
      ...(isHttps
        ? {
            rejectUnauthorized: init.tls?.rejectUnauthorized ?? true,
            ...(init.tls?.caPem ? { ca: init.tls.caPem } : {}),
            ...(effectiveServerName ? { servername: effectiveServerName } : {}),
          }
        : {}),
    };

    const requestFn = isHttps ? https.request : http.request;
    const req = requestFn(parsedUrl, requestOptions, (res) => {
      const responseHeaders = new Headers();
      for (const [headerName, headerValue] of Object.entries(res.headers)) {
        if (Array.isArray(headerValue)) {
          for (const itemValue of headerValue) responseHeaders.append(headerName, itemValue);
        } else if (typeof headerValue === "string") {
          responseHeaders.set(headerName, headerValue);
        }
      }
      const status = res.statusCode ?? 200;
      const statusText = res.statusMessage ?? "";
      const isNullBodyStatus =
        status === 101 ||
        status === 204 ||
        status === 205 ||
        status === 304 ||
        init.method === "HEAD";
      if (isNullBodyStatus) {
        res.resume();
        resolve(new Response(null, { status, statusText, headers: responseHeaders }));
        return;
      }

      const contentEncoding = (res.headers["content-encoding"] ?? "")
        .toString()
        .trim()
        .toLowerCase();
      let decodedStream: Readable = res;
      if (contentEncoding === "gzip" || contentEncoding === "x-gzip") {
        const gunzip = zlib.createGunzip();
        res.on("error", (err) => gunzip.destroy(err));
        decodedStream = res.pipe(gunzip);
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("content-length");
      } else if (contentEncoding === "deflate") {
        const inflate = zlib.createInflate();
        res.on("error", (err) => inflate.destroy(err));
        decodedStream = res.pipe(inflate);
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("content-length");
      } else if (contentEncoding === "br") {
        const brotli = zlib.createBrotliDecompress();
        res.on("error", (err) => brotli.destroy(err));
        decodedStream = res.pipe(brotli);
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("content-length");
      }

      const webStream = Readable.toWeb(decodedStream) as unknown as ReadableStream<Uint8Array>;
      resolve(new Response(webStream, { status, statusText, headers: responseHeaders }));
    });

    req.on("error", (err) => {
      reject(err);
    });

    if (init.body !== undefined && init.method !== "GET" && init.method !== "HEAD") {
      req.write(init.body);
    }
    req.end();
  });
}

/**
 * Read a `ReadableStream<Uint8Array>` up to `maxBytes` without buffering unbounded data into memory.
 */
export async function readStreamWithCap(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ buffer: Uint8Array; byteLength: number; streamTruncated: boolean }> {
  if (!stream) {
    return { buffer: new Uint8Array(0), byteLength: 0, streamTruncated: false };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalRead = 0;
  let streamTruncated = false;

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new Error("Request aborted.");
      }

      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      const remaining = maxBytes - totalRead;
      if (value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          totalRead += remaining;
        }
        streamTruncated = true;
        await reader.cancel().catch(() => {});
        break;
      }

      chunks.push(value);
      totalRead += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  const combined = new Uint8Array(totalRead);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    buffer: combined,
    byteLength: totalRead,
    streamTruncated,
  };
}

export interface HttpFetchExecutionResult {
  ok: boolean;
  status?: number;
  statusText?: string;
  httpOk?: boolean;
  method: HttpMethod;
  finalMethod: HttpMethod;
  initialUrl: string;
  finalUrl: string;
  redirected: boolean;
  redirectCount: number;
  redirectChain: string[];
  responseHeaders: Record<string, string>;
  requestHeaders: Record<string, string>;
  contentType: string;
  buffer: Uint8Array;
  byteLength: number;
  streamTruncated: boolean;
  maxBytesCap: number;
  tls: TlsSummary;
  elapsedMs: number;
  error?: string;
}

export type FetchFunction = (input: string | URL, init?: RequestInit & Record<string, unknown>) => Promise<Response>;

/**
 * Execute an HTTP/HTTPS request with pre-flight SSRF/DNS validation, authorization checks,
 * manual redirect handling, cross-origin credential stripping, and streaming byte cap.
 */
export async function executeHttpFetch(
  params: FetchInputParams,
  options: {
    ctx?: ExtensionContext;
    signal?: AbortSignal;
    fetchImpl?: FetchFunction;
    dnsLookup?: DnsLookupFunction;
  } = {},
): Promise<HttpFetchExecutionResult> {
  const startTime = Date.now();
  const elapsed = () => Date.now() - startTime;

  const methodCheck = normalizeHttpMethod(params.method);
  if (!methodCheck.ok || !methodCheck.method) {
    const fallbackUrl = redactUrl(params.url ?? "");
    return {
      ok: false,
      method: "GET",
      finalMethod: "GET",
      initialUrl: fallbackUrl,
      finalUrl: fallbackUrl,
      redirected: false,
      redirectCount: 0,
      redirectChain: [],
      responseHeaders: {},
      requestHeaders: redactHeaders(params.headers),
      contentType: "",
      buffer: new Uint8Array(0),
      byteLength: 0,
      streamTruncated: false,
      maxBytesCap: DEFAULT_MAX_BYTES,
      tls: tlsSummary("https:", params.tls),
      elapsedMs: elapsed(),
      error: methodCheck.error ?? "Invalid HTTP method",
    };
  }

  const initialMethod = methodCheck.method;
  const payloadPrep = prepareRequestPayload(initialMethod, params);
  if (!payloadPrep.ok) {
    const fallbackUrl = redactUrl(params.url ?? "");
    return {
      ok: false,
      method: initialMethod,
      finalMethod: initialMethod,
      initialUrl: fallbackUrl,
      finalUrl: fallbackUrl,
      redirected: false,
      redirectCount: 0,
      redirectChain: [],
      responseHeaders: {},
      requestHeaders: redactHeaders(payloadPrep.headers),
      contentType: "",
      buffer: new Uint8Array(0),
      byteLength: 0,
      streamTruncated: false,
      maxBytesCap: DEFAULT_MAX_BYTES,
      tls: tlsSummary("https:", params.tls),
      elapsedMs: elapsed(),
      error: payloadPrep.error,
    };
  }

  // Clamp numeric configuration bounds
  const timeoutMs = Math.min(
    Math.max(params.timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
    MAX_TIMEOUT_MS,
  );
  const followRedirects = params.followRedirects ?? true;
  const maxRedirects = Math.min(
    Math.max(params.maxRedirects ?? DEFAULT_MAX_REDIRECTS, 0),
    MAX_ALLOWED_REDIRECTS,
  );
  const maxBytes = Math.min(
    Math.max(params.maxBytes ?? DEFAULT_MAX_BYTES, MIN_MAX_BYTES),
    MAX_ALLOWED_BYTES,
  );

  // 1. Validate initial URL and resolve DNS
  const initialValidation = await validateTargetUrlAndResolve(params.url, {
    allowPrivateNetwork: params.allowPrivateNetwork,
    query: params.query,
    dnsLookup: options.dnsLookup,
  });

  if (!initialValidation.ok || !initialValidation.url) {
    const redactedInitial = initialValidation.redactedUrl ?? redactUrl(params.url ?? "");
    return {
      ok: false,
      method: initialMethod,
      finalMethod: initialMethod,
      initialUrl: redactedInitial,
      finalUrl: redactedInitial,
      redirected: false,
      redirectCount: 0,
      redirectChain: [],
      responseHeaders: {},
      requestHeaders: redactHeaders(payloadPrep.headers),
      contentType: "",
      buffer: new Uint8Array(0),
      byteLength: 0,
      streamTruncated: false,
      maxBytesCap: maxBytes,
      tls: tlsSummary(initialValidation.url?.protocol ?? "https:", params.tls),
      elapsedMs: elapsed(),
      error: initialValidation.error ?? "Target URL validation failed.",
    };
  }

  let currentUrl = initialValidation.url;
  let currentResolvedAddresses: string[] = initialValidation.resolvedAddresses ?? [];
  const initialRedactedUrl = initialValidation.redactedUrl ?? redactUrl(currentUrl.toString());

  // 2. Enforce in-tool authorization (read-only specialist check + confirmation for mutating/private/insecure TLS)
  const authCheck = await ensureFetchAuthorized({
    params,
    method: initialMethod,
    targetUrl: currentUrl.toString(),
    isPrivateTarget: Boolean(initialValidation.isPrivateTarget),
    isRedirectHop: false,
    ctx: options.ctx,
    signal: options.signal,
  });

  if (!authCheck.allowed) {
    return {
      ok: false,
      method: initialMethod,
      finalMethod: initialMethod,
      initialUrl: initialRedactedUrl,
      finalUrl: initialRedactedUrl,
      redirected: false,
      redirectCount: 0,
      redirectChain: [],
      responseHeaders: {},
      requestHeaders: redactHeaders(payloadPrep.headers),
      contentType: "",
      buffer: new Uint8Array(0),
      byteLength: 0,
      streamTruncated: false,
      maxBytesCap: maxBytes,
      tls: tlsSummary(currentUrl.protocol, params.tls),
      elapsedMs: elapsed(),
      error: authCheck.reason ?? "Request not authorized.",
    };
  }

  // Combine user cancellation signal with request timeout
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const customFetchFn = options.fetchImpl;
  let currentMethod: HttpMethod = initialMethod;
  let currentHeaders: Record<string, string> = { ...payloadPrep.headers };
  let currentBody: string | undefined = payloadPrep.body;

  const redirectChain: string[] = [initialRedactedUrl];
  let redirectCount = 0;

  try {
    while (true) {
      const tlsInit = buildTlsOptions(currentUrl.protocol, params.tls);

      const response = customFetchFn
        ? await customFetchFn(currentUrl.toString(), {
            method: currentMethod,
            headers: currentHeaders,
            body: currentMethod === "GET" || currentMethod === "HEAD" ? undefined : currentBody,
            redirect: "manual",
            signal: combinedSignal,
            pinnedAddresses: currentResolvedAddresses,
            ...tlsInit,
          })
        : await executePinnedHttpRequest(currentUrl.toString(), {
            method: currentMethod,
            headers: currentHeaders,
            body: currentMethod === "GET" || currentMethod === "HEAD" ? undefined : currentBody,
            signal: combinedSignal,
            tls: params.tls,
            resolvedAddresses: currentResolvedAddresses,
          });

      const locationHeader = response.headers.get("location");
      const isRedirectStatus = REDIRECT_STATUS_CODES.has(response.status) && Boolean(locationHeader);

      if (isRedirectStatus && followRedirects && locationHeader) {
        // Cancel unconsumed redirect body stream cleanly
        if (response.body) {
          await response.body.cancel().catch(() => {});
        }

        if (redirectCount >= maxRedirects) {
          return {
            ok: false,
            status: response.status,
            statusText: response.statusText,
            httpOk: false,
            method: initialMethod,
            finalMethod: currentMethod,
            initialUrl: initialRedactedUrl,
            finalUrl: redactUrl(currentUrl.toString()),
            redirected: redirectCount > 0,
            redirectCount,
            redirectChain,
            responseHeaders: redactHeaders(response.headers),
            requestHeaders: redactHeaders(currentHeaders),
            contentType: response.headers.get("content-type") ?? "",
            buffer: new Uint8Array(0),
            byteLength: 0,
            streamTruncated: false,
            maxBytesCap: maxBytes,
            tls: tlsSummary(currentUrl.protocol, params.tls),
            elapsedMs: elapsed(),
            error: `Maximum redirects (${maxRedirects}) exceeded. Redirect chain: ${redirectChain.join(" -> ")}`,
          };
        }

        let resolvedNextUrl: URL;
        try {
          resolvedNextUrl = new URL(locationHeader, currentUrl);
        } catch {
          return {
            ok: false,
            status: response.status,
            statusText: response.statusText,
            httpOk: false,
            method: initialMethod,
            finalMethod: currentMethod,
            initialUrl: initialRedactedUrl,
            finalUrl: redactUrl(currentUrl.toString()),
            redirected: redirectCount > 0,
            redirectCount,
            redirectChain,
            responseHeaders: redactHeaders(response.headers),
            requestHeaders: redactHeaders(currentHeaders),
            contentType: response.headers.get("content-type") ?? "",
            buffer: new Uint8Array(0),
            byteLength: 0,
            streamTruncated: false,
            maxBytesCap: maxBytes,
            tls: tlsSummary(currentUrl.protocol, params.tls),
            elapsedMs: elapsed(),
            error: `Redirect Location header "${redactUrl(locationHeader)}" could not be resolved as a valid URL.`,
          };
        }

        const hopValidation = await validateTargetUrlAndResolve(resolvedNextUrl.toString(), {
          allowPrivateNetwork: params.allowPrivateNetwork,
          dnsLookup: options.dnsLookup,
        });

        if (!hopValidation.ok || !hopValidation.url) {
          return {
            ok: false,
            status: response.status,
            statusText: response.statusText,
            httpOk: false,
            method: initialMethod,
            finalMethod: currentMethod,
            initialUrl: initialRedactedUrl,
            finalUrl: redactUrl(resolvedNextUrl.toString()),
            redirected: true,
            redirectCount: redirectCount + 1,
            redirectChain: [...redirectChain, redactUrl(resolvedNextUrl.toString())],
            responseHeaders: redactHeaders(response.headers),
            requestHeaders: redactHeaders(currentHeaders),
            contentType: response.headers.get("content-type") ?? "",
            buffer: new Uint8Array(0),
            byteLength: 0,
            streamTruncated: false,
            maxBytesCap: maxBytes,
            tls: tlsSummary(resolvedNextUrl.protocol, params.tls),
            elapsedMs: elapsed(),
            error: `Redirect blocked (${redactUrl(currentUrl.toString())} -> ${redactUrl(resolvedNextUrl.toString())}): ${hopValidation.error}`,
          };
        }

        const nextUrl = hopValidation.url;
        const sanitized = sanitizeHeadersForRedirect(currentUrl, nextUrl, currentHeaders);
        currentHeaders = sanitized.headers;

        // Per HTTP semantics: 303 (or 301/302 for POST) rewrites non-HEAD method to GET and drops body
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && currentMethod === "POST")
        ) {
          if (currentMethod !== "HEAD") {
            currentMethod = "GET";
          }
          currentBody = undefined;
          deleteHeaderCaseInsensitive(currentHeaders, "content-type");
          deleteHeaderCaseInsensitive(currentHeaders, "content-length");
        }

        // If redirect hop crosses into a private target, downgrades HTTPS -> HTTP,
        // or preserves a mutating method across a cross-origin redirect (307/308), verify authorization
        if (
          hopValidation.isPrivateTarget ||
          sanitized.protocolDowngraded ||
          (sanitized.originChanged && isMutatingMethod(currentMethod))
        ) {
          const hopAuth = await ensureFetchAuthorized({
            params,
            method: currentMethod,
            targetUrl: nextUrl.toString(),
            isPrivateTarget: Boolean(hopValidation.isPrivateTarget),
            isRedirectHop: true,
            originChanged: sanitized.originChanged,
            protocolDowngraded: sanitized.protocolDowngraded,
            ctx: options.ctx,
            signal: combinedSignal,
          });
          if (!hopAuth.allowed) {
            return {
              ok: false,
              status: response.status,
              statusText: response.statusText,
              httpOk: false,
              method: initialMethod,
              finalMethod: currentMethod,
              initialUrl: initialRedactedUrl,
              finalUrl: redactUrl(nextUrl.toString()),
              redirected: true,
              redirectCount: redirectCount + 1,
              redirectChain: [...redirectChain, redactUrl(nextUrl.toString())],
              responseHeaders: redactHeaders(response.headers),
              requestHeaders: redactHeaders(currentHeaders),
              contentType: response.headers.get("content-type") ?? "",
              buffer: new Uint8Array(0),
              byteLength: 0,
              streamTruncated: false,
              maxBytesCap: maxBytes,
              tls: tlsSummary(nextUrl.protocol, params.tls),
              elapsedMs: elapsed(),
              error: hopAuth.reason ?? "Redirect hop denied.",
            };
          }
        }

        currentUrl = nextUrl;
        currentResolvedAddresses = hopValidation.resolvedAddresses ?? [];
        redirectCount += 1;
        redirectChain.push(redactUrl(currentUrl.toString()));
        continue;
      }

      // Final response reached (or followRedirects === false)
      const streamData =
        currentMethod === "HEAD"
          ? { buffer: new Uint8Array(0), byteLength: 0, streamTruncated: false }
          : await readStreamWithCap(response.body, maxBytes, combinedSignal);

      const redactedRespHeaders = redactHeaders(response.headers);
      const redactedReqHeaders = redactHeaders(currentHeaders);
      const contentType = response.headers.get("content-type") ?? "";
      const finalRedactedUrl = redactUrl(currentUrl.toString());

      return {
        ok: true,
        status: response.status,
        statusText: response.statusText,
        httpOk: response.ok,
        method: initialMethod,
        finalMethod: currentMethod,
        initialUrl: initialRedactedUrl,
        finalUrl: finalRedactedUrl,
        redirected: redirectCount > 0,
        redirectCount,
        redirectChain,
        responseHeaders: redactedRespHeaders,
        requestHeaders: redactedReqHeaders,
        contentType,
        buffer: streamData.buffer,
        byteLength: streamData.byteLength,
        streamTruncated: streamData.streamTruncated,
        maxBytesCap: maxBytes,
        tls: tlsSummary(currentUrl.protocol, params.tls),
        elapsedMs: elapsed(),
      };
    }
  } catch (err) {
    const isTimeout = timeoutSignal.aborted && !(options.signal?.aborted);
    const rawMsg = err instanceof Error ? err.message : String(err);
    const errorMsg = isTimeout
      ? `Request timed out after ${timeoutMs}ms (${currentMethod} ${redactUrl(currentUrl.toString())}).`
      : `Fetch error (${currentMethod} ${redactUrl(currentUrl.toString())}): ${rawMsg}`;

    return {
      ok: false,
      method: initialMethod,
      finalMethod: currentMethod,
      initialUrl: initialRedactedUrl,
      finalUrl: redactUrl(currentUrl.toString()),
      redirected: redirectCount > 0,
      redirectCount,
      redirectChain,
      responseHeaders: {},
      requestHeaders: redactHeaders(currentHeaders),
      contentType: "",
      buffer: new Uint8Array(0),
      byteLength: 0,
      streamTruncated: false,
      maxBytesCap: maxBytes,
      tls: tlsSummary(currentUrl.protocol, params.tls),
      elapsedMs: elapsed(),
      error: errorMsg,
    };
  }
}
