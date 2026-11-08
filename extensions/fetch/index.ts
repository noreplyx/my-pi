/**
 * `fetch` — Full-featured HTTP/HTTPS client tool extension for Pi.
 *
 * Supports GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS; request bodies (`body`, `json`, `form`);
 * query parameters; custom headers with automatic secret redaction; manual redirect validation
 * with SSRF / cloud-metadata / private-network guards; TLS configuration; and multi-format
 * response processing (`auto`, `json`, `markdown`, `text`, `raw`, `base64`, plus inline image blocks)
 * with streaming byte caps and 2000-line / 50KB truncation.
 */

import { appendFile, mkdir } from "node:fs/promises";
import * as path from "node:path";
import {
  formatSize,
  getAgentDir,
  withFileMutationQueue,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { executeHttpFetch } from "./client.ts";
import { formatResponseBody, parseMimeType } from "./format.ts";
import { redactHeaders, resolveRedactedRequestUrl } from "./redaction.ts";
import {
  type FetchDetails,
  type FetchInputParams,
  FetchOutputSchema,
  FetchParams,
  type FetchStructuredOutput,
  type ResponseFormat,
} from "./types.ts";

function fetchAuditLogPath(): string {
  return path.join(getAgentDir(), "permissions", "audit.log");
}

/**
 * Append a structured, secret-redacted observability entry to the agent audit log.
 * Never throws and never writes to stdout.
 */
async function logFetchEvent(entry: {
  method: string;
  redactedUrl: string;
  status?: number;
  outcome: "ok" | "http_error" | "blocked_or_failed";
  elapsedMs: number;
  byteLength?: number;
  error?: string;
}): Promise<void> {
  const agent = process.env.PI_AGENT_NAME?.trim() || "main";
  const statusPart = entry.status !== undefined ? ` status=${entry.status}` : "";
  const bytesPart = entry.byteLength !== undefined ? ` bytes=${entry.byteLength}` : "";
  const errorPart = entry.error ? ` error=${JSON.stringify(entry.error.slice(0, 300))}` : "";
  const line = `[${new Date().toISOString()}] agent=${agent} FETCH_EXEC outcome=${entry.outcome} method=${entry.method} url=${JSON.stringify(entry.redactedUrl.slice(0, 400))}${statusPart}${bytesPart} elapsedMs=${entry.elapsedMs}${errorPart}\n`;
  try {
    const logPath = fetchAuditLogPath();
    await withFileMutationQueue(logPath, async () => {
      await mkdir(path.dirname(logPath), { recursive: true });
      await appendFile(logPath, line);
    });
  } catch {
    // Observability logging must never break tool execution
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "fetch",
    label: "HTTP Fetch",
    description: [
      "Make HTTP/HTTPS requests (GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS).",
      "Supports `query` parameters, custom `headers` (credentials/tokens are redacted in output and logs),",
      "and request payloads via `json` (auto-serialized as application/json), `form` (application/x-www-form-urlencoded), or raw `body`.",
      "Response `format` modes: `auto` (default: pretty-prints JSON, converts HTML to Markdown, returns PNG/JPEG/GIF/WebP as image blocks, spills binary to temp files), `json`, `markdown`, `text`, `raw`, or `base64`.",
      "Includes SSRF protection (cloud metadata endpoints are unconditionally blocked; private/loopback IPs require `allowPrivateNetwork: true`),",
      "per-hop redirect validation (`followRedirects`, `maxRedirects`), `timeoutMs`, and `tls` options (`rejectUnauthorized`, `caPem`, `serverName`).",
      "Text output is truncated to 2000 lines or 50KB (whichever is hit first), with full output saved to a temp file.",
    ].join(" "),
    promptSnippet: "Perform HTTP/HTTPS requests (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS) with JSON/form/body payloads and HTML/JSON/Markdown formatting",
    promptGuidelines: [
      "Prefer `fetch` over `bash` (`curl`/`Invoke-WebRequest`) for HTTP/HTTPS API calls, web page retrieval, and service health checks.",
    ],
    parameters: FetchParams,
    outputSchema: FetchOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = (rawParams ?? {}) as FetchInputParams;
      const requestedFormat: ResponseFormat = params.format ?? "auto";

      const execResult = await executeHttpFetch(params, { ctx, signal });

      if (!execResult.ok) {
        await logFetchEvent({
          method: execResult.method,
          redactedUrl: execResult.finalUrl || execResult.initialUrl,
          status: execResult.status,
          outcome: "blocked_or_failed",
          elapsedMs: execResult.elapsedMs,
          error: execResult.error,
        });

        const structuredError: FetchStructuredOutput = {
          ok: false,
          status: execResult.status,
          statusText: execResult.statusText,
          method: execResult.method,
          url: execResult.initialUrl,
          finalUrl: execResult.finalUrl,
          redirected: execResult.redirected,
          redirectCount: execResult.redirectCount,
          redirectChain: execResult.redirectChain,
          headers: execResult.responseHeaders,
          requestHeaders: execResult.requestHeaders,
          elapsedMs: execResult.elapsedMs,
          tls: execResult.tls,
          error: execResult.error ?? "HTTP fetch failed.",
        };

        const details: FetchDetails = { ...structuredError };

        return {
          content: [{ type: "text" as const, text: execResult.error ?? "HTTP fetch failed." }],
          details,
          structuredContent: structuredError,
          isError: true,
        };
      }

      const formatted = await formatResponseBody({
        buffer: execResult.buffer,
        contentType: execResult.contentType,
        requestedFormat,
        finalUrl: execResult.finalUrl,
        streamTruncated: execResult.streamTruncated,
        maxBytesCap: execResult.maxBytesCap,
      });

      await logFetchEvent({
        method: execResult.method,
        redactedUrl: execResult.finalUrl,
        status: execResult.status,
        outcome: execResult.httpOk ? "ok" : "http_error",
        elapsedMs: execResult.elapsedMs,
        byteLength: execResult.byteLength,
      });

      const statusHeaderParts = [
        `HTTP ${execResult.status} ${execResult.statusText || ""}`.trim(),
        `${execResult.method}${execResult.finalMethod !== execResult.method ? `->${execResult.finalMethod}` : ""} ${execResult.finalUrl}`,
        `(${formatSize(execResult.byteLength)}, ${execResult.elapsedMs}ms${execResult.redirectCount > 0 ? `, ${execResult.redirectCount} redirect${execResult.redirectCount === 1 ? "" : "s"}` : ""})`,
      ];
      if (execResult.contentType) {
        statusHeaderParts.push(`[${parseMimeType(execResult.contentType) || execResult.contentType}]`);
      }

      const headerSummaryLine = statusHeaderParts.join(" ");
      const fullDisplayText = formatted.bodyText
        ? `${headerSummaryLine}\n\n${formatted.bodyText}`
        : `${headerSummaryLine}\n\n(empty body)`;

      const contentBlocks: Array<
        { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
      > = [{ type: "text", text: fullDisplayText }];

      if (formatted.imageBlock) {
        contentBlocks.push(formatted.imageBlock);
      }

      const structured: FetchStructuredOutput = {
        status: execResult.status,
        statusText: execResult.statusText,
        ok: execResult.httpOk,
        method: execResult.method,
        url: execResult.initialUrl,
        finalUrl: execResult.finalUrl,
        redirected: execResult.redirected,
        redirectCount: execResult.redirectCount,
        redirectChain: execResult.redirectChain,
        headers: execResult.responseHeaders,
        requestHeaders: execResult.requestHeaders,
        contentType: execResult.contentType,
        byteLength: execResult.byteLength,
        format: formatted.resolvedFormat,
        body: formatted.bodyText,
        ...(formatted.parsedJson !== undefined ? { json: formatted.parsedJson } : {}),
        ...(formatted.imageBlock
          ? { image: { data: formatted.imageBlock.data, mimeType: formatted.imageBlock.mimeType } }
          : {}),
        truncated: formatted.truncated,
        ...(formatted.fullOutputPath ? { fullOutputPath: formatted.fullOutputPath } : {}),
        elapsedMs: execResult.elapsedMs,
        tls: execResult.tls,
      };

      const details: FetchDetails = {
        ...structured,
        outputLines: formatted.outputLines,
        totalLines: formatted.totalLines,
        outputBytes: formatted.outputBytes,
        totalBytes: formatted.totalBytes,
        streamTruncated: execResult.streamTruncated,
      };

      return {
        content: contentBlocks,
        details,
        structuredContent: structured,
      };
    },

    renderCall(args, theme, _context) {
      const callArgs = (args ?? {}) as Partial<FetchInputParams>;
      const method = (callArgs.method ?? "GET").toUpperCase();
      const displayUrl =
        typeof callArgs.url === "string" && callArgs.url.trim()
          ? resolveRedactedRequestUrl(callArgs.url, callArgs.query)
          : "(no url)";

      const methodColor =
        method === "GET" || method === "HEAD" || method === "OPTIONS" ? "accent" : "warning";

      let text =
        theme.fg("toolTitle", theme.bold("fetch ")) +
        theme.fg(methodColor, theme.bold(method)) +
        " " +
        theme.fg("muted", displayUrl);

      const badges: string[] = [];
      if (callArgs.format && callArgs.format !== "auto") badges.push(`format=${callArgs.format}`);
      if (callArgs.allowPrivateNetwork) badges.push("private-net");
      if (callArgs.tls?.rejectUnauthorized === false) badges.push("insecure-tls");
      if (callArgs.json !== undefined) badges.push("json-body");
      else if (callArgs.form !== undefined) badges.push("form-body");
      else if (callArgs.body !== undefined) badges.push("raw-body");

      if (badges.length > 0) {
        text += " " + theme.fg("dim", `[${badges.join(", ")}]`);
      }

      if (callArgs.headers && Object.keys(callArgs.headers).length > 0) {
        const safeHeaders = redactHeaders(callArgs.headers);
        const headerPreview = Object.entries(safeHeaders)
          .slice(0, 4)
          .map(([headerName, headerValue]) => `${headerName}: ${headerValue}`)
          .join(", ");
        const moreCount = Object.keys(safeHeaders).length - 4;
        text += `\n  ${theme.fg("dim", `headers: ${headerPreview}${moreCount > 0 ? ` (+${moreCount} more)` : ""}`)}`;
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const resultDetails = result.details as FetchDetails | undefined;
      const first = result.content[0];
      const fullText = first?.type === "text" ? first.text : "(no output)";

      const isSuccess = !result.isError && (resultDetails?.ok ?? true);
      const icon = result.isError
        ? theme.fg("error", "✗")
        : isSuccess
          ? theme.fg("success", "✓")
          : theme.fg("warning", "!");

      let header = `${icon} ${theme.fg("toolTitle", theme.bold("fetch"))}`;
      if (resultDetails?.method) {
        header += ` ${theme.fg("accent", resultDetails.method)}`;
      }
      if (typeof resultDetails?.status === "number") {
        const statusColor =
          resultDetails.status >= 200 && resultDetails.status < 300
            ? "success"
            : resultDetails.status >= 400
              ? "error"
              : "warning";
        header += ` ${theme.fg(statusColor, `${resultDetails.status}${resultDetails.statusText ? ` ${resultDetails.statusText}` : ""}`)}`;
      }
      if (resultDetails?.finalUrl) {
        header += ` ${theme.fg("muted", resultDetails.finalUrl)}`;
      }
      const metaParts: string[] = [];
      if (typeof resultDetails?.byteLength === "number") {
        metaParts.push(formatSize(resultDetails.byteLength));
      }
      if (typeof resultDetails?.elapsedMs === "number") {
        metaParts.push(`${resultDetails.elapsedMs}ms`);
      }
      if (resultDetails?.format) metaParts.push(resultDetails.format);
      if (resultDetails?.truncated) metaParts.push("truncated");
      if (metaParts.length > 0) {
        header += theme.fg("dim", ` (${metaParts.join(", ")})`);
      }

      if (result.isError) {
        return new Text(`${header}\n${theme.fg("error", fullText)}`, 0, 0);
      }

      const bodyOnly = resultDetails?.body ?? fullText;
      const lines = bodyOnly.split("\n");
      const previewLines = expanded ? lines : lines.slice(0, 14);
      const previewText = previewLines.join("\n");
      const moreSuffix =
        !expanded && lines.length > 14
          ? `\n${theme.fg("dim", `… (${lines.length - 14} more lines)`)}`
          : "";

      return new Text(`${header}\n${theme.fg("toolOutput", previewText)}${moreSuffix}`, 0, 0);
    },
  });
}
