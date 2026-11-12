/**
 * HTML-to-Markdown conversion, multi-format response dispatching,
 * and 2000-line / 50KB output truncation with temp-file spill.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES as PI_MAX_TEXT_BYTES,
  DEFAULT_MAX_LINES as PI_MAX_TEXT_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { MAX_IMAGE_INLINE_BYTES, type ResponseFormat } from "./types.ts";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  bull: "•",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * Decode common named and numeric (`&#123;`, `&#x1F600;`) HTML entities.
 */
export function decodeHtmlEntities(input: string): string {
  if (!input || !input.includes("&")) return input;
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z0-9]+);/g, (full, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      if (!Number.isNaN(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return full;
        }
      }
      return full;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      if (!Number.isNaN(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return full;
        }
      }
      return full;
    }
    const lower = entity.toLowerCase();
    return NAMED_ENTITIES[lower] ?? full;
  });
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function resolveHref(href: string, baseUrl?: string): string {
  const trimmed = decodeHtmlEntities(href.trim());
  if (!trimmed || trimmed.startsWith("javascript:") || trimmed.startsWith("vbscript:")) {
    return "";
  }
  if (!baseUrl) return trimmed;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return trimmed;
  }
}

/**
 * Convert an HTML document or fragment into clean, readable Markdown without external DOM dependencies.
 */
export function htmlToMarkdown(rawHtml: string, baseUrl?: string): string {
  if (!rawHtml) return "";

  let working = rawHtml.replace(/\r\n?/g, "\n");

  // Extract <title> if present
  let pageTitle = "";
  const titleMatch = working.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch && titleMatch[1]) {
    pageTitle = decodeHtmlEntities(stripTags(titleMatch[1]));
  }

  // Remove HTML comments, DOCTYPE, and non-content blocks
  working = working
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<(script|style|noscript|template|svg|iframe|canvas|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Protect <pre> blocks using placeholders so whitespace inside code blocks is preserved
  const codeBlockPlaceholders: string[] = [];
  working = working.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_fullMatch, inner: string) => {
    let language = "";
    const langMatch = inner.match(/<code\b[^>]*class=["'][^"']*?\b(?:language|lang)-([a-zA-Z0-9_+-]+)[^"']*["'][^>]*>/i);
    if (langMatch && langMatch[1]) {
      language = langMatch[1];
    }
    const strippedCode = decodeHtmlEntities(
      inner
        .replace(/^[\s]*<code\b[^>]*>/i, "")
        .replace(/<\/code>[\s]*$/i, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, ""),
    ).replace(/\n+$/, "");

    const placeholderIndex = codeBlockPlaceholders.length;
    codeBlockPlaceholders.push(`\n\n\`\`\`${language}\n${strippedCode}\n\`\`\`\n\n`);
    return `\u0000CODEBLOCK_${placeholderIndex}\u0000`;
  });

  // Protect inline <code>...</code> using placeholders so escaped HTML inside inline code is not stripped as tags
  const inlineCodePlaceholders: string[] = [];
  working = working.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_fullMatch, inner: string) => {
    const strippedText = decodeHtmlEntities(stripTags(inner)).replace(/`/g, "\\`");
    if (!strippedText) return "";
    const placeholderIndex = inlineCodePlaceholders.length;
    inlineCodePlaceholders.push(`\`${strippedText}\``);
    return `\u0000INLINECODE_${placeholderIndex}\u0000`;
  });

  // Convert tables <table>...</table>
  working = working.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_fullMatch, tableInner: string) => {
    const rows: string[][] = [];
    const rowMatches = tableInner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi);
    for (const rowMatch of rowMatches) {
      const cells: string[] = [];
      const cellMatches = rowMatch[1].matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi);
      for (const cellMatch of cellMatches) {
        const cellText = stripTags(cellMatch[2]).replace(/\|/g, "\\|");
        cells.push(cellText);
      }
      if (cells.length > 0) {
        rows.push(cells);
      }
    }
    if (rows.length === 0) return "";
    const colCount = Math.max(...rows.map((rowCells) => rowCells.length));
    const normalizedRows = rows.map((rowCells) => {
      const padded = [...rowCells];
      while (padded.length < colCount) padded.push("");
      return padded;
    });
    const headerLine = `| ${normalizedRows[0].join(" | ")} |`;
    const separatorLine = `| ${normalizedRows[0].map(() => "---").join(" | ")} |`;
    const bodyLines = normalizedRows.slice(1).map((rowCells) => `| ${rowCells.join(" | ")} |`);
    return `\n\n${[headerLine, separatorLine, ...bodyLines].join("\n")}\n\n`;
  });

  // Convert headings <h1>..<h6>
  working = working.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_fullMatch, levelStr: string, inner: string) => {
    const level = Number(levelStr);
    const hashes = "#".repeat(Math.min(Math.max(level, 1), 6));
    const headingText = stripTags(inner);
    return headingText ? `\n\n${hashes} ${headingText}\n\n` : "";
  });

  // Convert images <img alt="..." src="...">
  working = working.replace(/<img\b([^>]*?)\/?>/gi, (_fullMatch, attrs: string) => {
    const srcMatch = attrs.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i);
    const altMatch = attrs.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i);
    const rawSrc = srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? "";
    const rawAlt = altMatch?.[1] ?? altMatch?.[2] ?? altMatch?.[3] ?? "";
    const resolvedSrc = resolveHref(rawSrc, baseUrl);
    if (!resolvedSrc) return "";
    const alt = stripTags(rawAlt);
    return `![${alt}](${resolvedSrc})`;
  });

  // Convert links <a href="...">...</a>
  working = working.replace(/<a\b([^>]*?)>([\s\S]*?)<\/a>/gi, (_fullMatch, attrs: string, inner: string) => {
    const hrefMatch = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i);
    const rawHref = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "";
    const strippedText = stripTags(inner);
    const resolved = resolveHref(rawHref, baseUrl);
    if (!resolved) return strippedText;
    if (!strippedText) return resolved;
    return `[${strippedText}](${resolved})`;
  });

  // Convert emphasis and strong tags
  working = working
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_fullMatch, _tag, inner: string) => {
      const strippedText = stripTags(inner);
      return strippedText ? `**${strippedText}**` : "";
    })
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_fullMatch, _tag, inner: string) => {
      const strippedText = stripTags(inner);
      return strippedText ? `*${strippedText}*` : "";
    })
    .replace(/<(del|s|strike)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_fullMatch, _tag, inner: string) => {
      const strippedText = stripTags(inner);
      return strippedText ? `~~${strippedText}~~` : "";
    });

  // Convert blockquotes
  working = working.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_fullMatch, inner: string) => {
    const strippedText = stripTags(inner);
    if (!strippedText) return "";
    const quoted = strippedText
      .split("\n")
      .map((line) => `> ${line.trim()}`)
      .join("\n");
    return `\n\n${quoted}\n\n`;
  });

  // Convert ordered lists <ol>...</ol>
  working = working.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_fullMatch, inner: string) => {
    let itemIndex = 1;
    const items: string[] = [];
    const liMatches = inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi);
    for (const li of liMatches) {
      const itemText = stripTags(li[1]);
      if (itemText) {
        items.push(`${itemIndex}. ${itemText}`);
        itemIndex += 1;
      }
    }
    return items.length > 0 ? `\n\n${items.join("\n")}\n\n` : "";
  });

  // Convert unordered lists <ul>...</ul> and any remaining <li>
  working = working.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_fullMatch, inner: string) => {
    const items: string[] = [];
    const liMatches = inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi);
    for (const li of liMatches) {
      const itemText = stripTags(li[1]);
      if (itemText) {
        items.push(`- ${itemText}`);
      }
    }
    return items.length > 0 ? `\n\n${items.join("\n")}\n\n` : "";
  });
  working = working.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_fullMatch, inner: string) => {
    const itemText = stripTags(inner);
    return itemText ? `\n- ${itemText}` : "";
  });

  // Horizontal rules and line breaks
  working = working
    .replace(/<hr\b[^>]*\/?>/gi, "\n\n---\n\n")
    .replace(/<br\b[^>]*\/?>/gi, "\n");

  // Block-level boundaries
  working = working.replace(
    /<\/?(p|div|section|article|main|header|footer|nav|aside|figure|figcaption|details|summary|dd|dt|dl)\b[^>]*>/gi,
    "\n\n",
  );

  // Strip remaining HTML tags
  working = working.replace(/<[^>]+>/g, "");

  // Decode entities once after all HTML tags have been stripped
  working = decodeHtmlEntities(working);

  // Normalize horizontal whitespace on lines (outside code blocks)
  working = working
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n");

  // Restore inline code and fenced code block placeholders
  working = working.replace(/\u0000INLINECODE_(\d+)\u0000/g, (_fullMatch, placeholderIndexText: string) => {
    const itemIndex = Number(placeholderIndexText);
    return inlineCodePlaceholders[itemIndex] ?? "";
  });

  working = working.replace(/\u0000CODEBLOCK_(\d+)\u0000/g, (_fullMatch, placeholderIndexText: string) => {
    const itemIndex = Number(placeholderIndexText);
    return codeBlockPlaceholders[itemIndex] ?? "";
  });

  // Collapse 3+ consecutive newlines to 2
  working = working.replace(/\n{3,}/g, "\n\n").trim();

  if (pageTitle && !working.startsWith(`# ${pageTitle}`)) {
    working = `# ${pageTitle}\n\n${working}`.trim();
  }

  return working;
}

export interface TruncateAndSpillResult {
  text: string;
  truncated: boolean;
  fullOutputPath?: string;
  outputLines: number;
  totalLines: number;
  outputBytes: number;
  totalBytes: number;
}

/**
 * Truncate formatted text to Pi's standard 2000-line / 50KB limits (`truncateHead`).
 * When truncated (or when the upstream stream hit `maxBytes`), write the full captured
 * body to a temp file and append a clear notice with the saved file path.
 */
export async function truncateAndSpill(
  fullText: string,
  options: {
    streamTruncated?: boolean;
    maxBytesCap?: number;
    fileExtension?: string;
  } = {},
): Promise<TruncateAndSpillResult> {
  const truncation = truncateHead(fullText, {
    maxLines: PI_MAX_TEXT_LINES,
    maxBytes: PI_MAX_TEXT_BYTES,
  });

  const isTruncated = truncation.truncated || Boolean(options.streamTruncated);
  let outputText = truncation.content;
  let fullOutputPath: string | undefined;

  if (isTruncated) {
    try {
      const dir = await mkdtemp(join(tmpdir(), "pi-safe-fetch-"));
      const ext = options.fileExtension ?? "txt";
      fullOutputPath = join(dir, `response.${ext}`);
      await writeFile(fullOutputPath, fullText, "utf-8");
    } catch {
      fullOutputPath = undefined;
    }

    const notes: string[] = [];
    if (options.streamTruncated && options.maxBytesCap) {
      notes.push(`Response stream exceeded maxBytes (${formatSize(options.maxBytesCap)}) and was capped.`);
    }
    if (truncation.truncated) {
      notes.push(
        `Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`,
      );
    }
    if (fullOutputPath) {
      notes.push(`Full output saved to: ${fullOutputPath}`);
    }
    outputText += `\n\n[${notes.join(" ")}]`;
  }

  return {
    text: outputText,
    truncated: isTruncated,
    fullOutputPath,
    outputLines: truncation.outputLines,
    totalLines: truncation.totalLines,
    outputBytes: truncation.outputBytes,
    totalBytes: truncation.totalBytes,
  };
}

export interface FormattedResponseResult {
  resolvedFormat: ResponseFormat | "image" | "binary";
  bodyText: string;
  parsedJson?: unknown;
  imageBlock?: { type: "image"; data: string; mimeType: string };
  truncated: boolean;
  fullOutputPath?: string;
  outputLines?: number;
  totalLines?: number;
  outputBytes?: number;
  totalBytes?: number;
}

/**
 * Extract the normalized MIME essence (e.g. `application/json`, `text/html`, `image/png`)
 * from a `Content-Type` header string.
 */
export function parseMimeType(contentTypeHeader: string | undefined | null): string {
  if (!contentTypeHeader) return "";
  return contentTypeHeader.split(";")[0].trim().toLowerCase();
}

function isJsonMime(mime: string): boolean {
  return mime === "application/json" || mime === "text/json" || mime.endsWith("+json");
}

function isHtmlMime(mime: string): boolean {
  return mime === "text/html" || mime === "application/xhtml+xml";
}

function isTextualMime(mime: string): boolean {
  if (!mime) return true;
  if (mime.startsWith("text/")) return true;
  if (isJsonMime(mime) || isHtmlMime(mime)) return true;
  if (
    mime === "application/xml" ||
    mime.endsWith("+xml") ||
    mime === "application/javascript" ||
    mime === "application/ecmascript" ||
    mime === "application/x-www-form-urlencoded" ||
    mime === "application/graphql" ||
    mime === "application/yaml" ||
    mime === "application/x-yaml" ||
    mime === "application/toml" ||
    mime === "application/csv"
  ) {
    return true;
  }
  return false;
}

/**
 * Heuristic check whether a byte buffer looks like binary data (contains NUL bytes
 * or a high ratio of non-printable control characters).
 */
function looksLikeBinaryBuffer(buffer: Uint8Array): boolean {
  const sampleLength = Math.min(buffer.byteLength, 4096);
  if (sampleLength === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < sampleLength; i++) {
    const byte = buffer[i];
    if (byte === 0) return true; // NUL byte
    if (byte < 7 || (byte > 14 && byte < 32 && byte !== 27)) {
      suspicious += 1;
    }
  }
  return suspicious / sampleLength > 0.15;
}

/**
 * Format the raw response buffer according to `requestedFormat` and `contentType`,
 * applying truncation and temp-file spill.
 */
export async function formatResponseBody(options: {
  buffer: Uint8Array;
  contentType: string;
  requestedFormat: ResponseFormat;
  finalUrl: string;
  streamTruncated?: boolean;
  maxBytesCap?: number;
}): Promise<FormattedResponseResult> {
  const { buffer, contentType, requestedFormat, finalUrl, streamTruncated, maxBytesCap } = options;
  const mime = parseMimeType(contentType);

  // 1. Explicit base64 mode
  if (requestedFormat === "base64") {
    const base64EncodedBody = Buffer.from(buffer).toString("base64");
    const spilled = await truncateAndSpill(base64EncodedBody, {
      streamTruncated,
      maxBytesCap,
      fileExtension: "b64",
    });
    return {
      resolvedFormat: "base64",
      bodyText: spilled.text,
      truncated: spilled.truncated,
      fullOutputPath: spilled.fullOutputPath,
      outputLines: spilled.outputLines,
      totalLines: spilled.totalLines,
      outputBytes: spilled.outputBytes,
      totalBytes: spilled.totalBytes,
    };
  }

  // 2. Image handling in `auto` mode
  if (
    requestedFormat === "auto" &&
    SUPPORTED_IMAGE_MIME_TYPES.has(mime) &&
    !streamTruncated &&
    buffer.byteLength > 0 &&
    buffer.byteLength <= MAX_IMAGE_INLINE_BYTES
  ) {
    const base64Data = Buffer.from(buffer).toString("base64");
    const summary = `[Image response: ${mime}, ${formatSize(buffer.byteLength)}, source: ${finalUrl}]`;
    return {
      resolvedFormat: "image",
      bodyText: summary,
      imageBlock: {
        type: "image",
        data: base64Data,
        mimeType: mime,
      },
      truncated: false,
      outputLines: 1,
      totalLines: 1,
      outputBytes: buffer.byteLength,
      totalBytes: buffer.byteLength,
    };
  }

  // 3. Binary payload handling in `auto` mode (non-textual MIME or binary byte signature)
  if (requestedFormat === "auto" && (!isTextualMime(mime) || looksLikeBinaryBuffer(buffer))) {
    let fullOutputPath: string | undefined;
    try {
      const dir = await mkdtemp(join(tmpdir(), "pi-safe-fetch-bin-"));
      const ext = mime.split("/")[1]?.replace(/[^a-zA-Z0-9._-]/g, "") || "bin";
      fullOutputPath = join(dir, `payload.${ext}`);
      await writeFile(fullOutputPath, buffer);
    } catch {
      fullOutputPath = undefined;
    }

    const summaryLines = [
      `[Binary response body (${mime || "application/octet-stream"}, ${formatSize(buffer.byteLength)}) omitted from text output.]`,
    ];
    if (streamTruncated && maxBytesCap) {
      summaryLines.push(`[Stream exceeded maxBytes (${formatSize(maxBytesCap)}) and was capped.]`);
    }
    if (fullOutputPath) {
      summaryLines.push(`[Saved binary payload to: ${fullOutputPath}]`);
    }

    return {
      resolvedFormat: "binary",
      bodyText: summaryLines.join("\n"),
      truncated: Boolean(streamTruncated),
      fullOutputPath,
      outputLines: summaryLines.length,
      totalLines: summaryLines.length,
      outputBytes: buffer.byteLength,
      totalBytes: buffer.byteLength,
    };
  }

  const rawUtf8 = new TextDecoder("utf-8", { fatal: false }).decode(buffer);

  // 4. JSON formatting (`json` or `auto` with JSON content-type)
  if (requestedFormat === "json" || (requestedFormat === "auto" && isJsonMime(mime))) {
    let parsedJson: unknown;
    let formattedJsonText = rawUtf8;
    try {
      parsedJson = JSON.parse(rawUtf8);
      formattedJsonText = JSON.stringify(parsedJson, null, 2);
    } catch {
      if (requestedFormat === "json") {
        formattedJsonText = `[Warning: response body is not valid JSON]\n${rawUtf8}`;
      }
    }

    const spilled = await truncateAndSpill(formattedJsonText, {
      streamTruncated,
      maxBytesCap,
      fileExtension: "json",
    });

    return {
      resolvedFormat: "json",
      bodyText: spilled.text,
      parsedJson,
      truncated: spilled.truncated,
      fullOutputPath: spilled.fullOutputPath,
      outputLines: spilled.outputLines,
      totalLines: spilled.totalLines,
      outputBytes: spilled.outputBytes,
      totalBytes: spilled.totalBytes,
    };
  }

  // 5. Markdown formatting (`markdown` or `auto` with HTML content-type)
  if (requestedFormat === "markdown" || (requestedFormat === "auto" && isHtmlMime(mime))) {
    const markdownText = htmlToMarkdown(rawUtf8, finalUrl);
    const spilled = await truncateAndSpill(markdownText, {
      streamTruncated,
      maxBytesCap,
      fileExtension: "md",
    });

    return {
      resolvedFormat: "markdown",
      bodyText: spilled.text,
      truncated: spilled.truncated,
      fullOutputPath: spilled.fullOutputPath,
      outputLines: spilled.outputLines,
      totalLines: spilled.totalLines,
      outputBytes: spilled.outputBytes,
      totalBytes: spilled.totalBytes,
    };
  }

  // 6. Plain `text` or `raw` (or `auto` fallback for text/*, xml, etc.)
  const effectiveFormat: ResponseFormat = requestedFormat === "raw" ? "raw" : "text";
  const spilled = await truncateAndSpill(rawUtf8, {
    streamTruncated,
    maxBytesCap,
    fileExtension: "txt",
  });

  return {
    resolvedFormat: effectiveFormat,
    bodyText: spilled.text,
    truncated: spilled.truncated,
    fullOutputPath: spilled.fullOutputPath,
    outputLines: spilled.outputLines,
    totalLines: spilled.totalLines,
    outputBytes: spilled.outputBytes,
    totalBytes: spilled.totalBytes,
  };
}
