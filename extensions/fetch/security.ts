/**
 * Security, SSRF prevention, DNS validation, secret redaction, and authorization
 * guards for the `safe-fetch` extension.
 */

import * as dns from "node:dns/promises";
import * as net from "node:net";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isAutoApproveEnabled } from "../auto-approve/state.ts";
import { evaluate } from "../permissions/loader.ts";
import {
  buildRequestUrl,
  isSensitiveHeaderName,
  redactFetchArgsSummary,
  redactHeaders,
  redactHeaderValue,
  redactUrl,
  resolveRedactedRequestUrl,
} from "./redaction.ts";
import type { FetchInputParams, HttpMethod } from "./types.ts";

export {
  buildRequestUrl,
  isSensitiveHeaderName,
  redactFetchArgsSummary,
  redactHeaders,
  redactHeaderValue,
  redactUrl,
  resolveRedactedRequestUrl,
};

export const READ_ONLY_SPECIALIST_AGENTS = new Set([
  "brainstorm",
  "code-production-designer",
  "code-test-designer",
  "code-reviewer",
]);

const BLOCKED_METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.azure.internal",
  "instance-data",
  "metadata",
]);

export interface UrlValidationResult {
  ok: boolean;
  url?: URL;
  redactedUrl?: string;
  resolvedAddresses?: string[];
  isPrivateTarget?: boolean;
  error?: string;
}

/**
 * Strip surrounding IPv6 brackets, trailing DNS dot, and IPv6 zone index (`%...` or `%25...`).
 */
function stripIpv6BracketsAndZone(rawHost: string): string {
  return rawHost
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .split(/%25|%/i)[0]
    .trim();
}

/**
 * Parse an IPv4 dotted-quad into 4 octets `[firstOctet, secondOctet, thirdOctet, fourthOctet]`, or `null` if invalid.
 */
function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octetValue = Number(part);
    if (octetValue < 0 || octetValue > 255) return null;
    octets.push(octetValue);
  }
  return [octets[0], octets[1], octets[2], octets[3]];
}

/**
 * Expand an IPv6 address into 8 16-bit integer groups, or `null` if invalid.
 */
function parseIpv6Groups(rawIp: string): number[] | null {
  // Strip brackets and zone index if present (e.g. fe80::1%eth0 or [fe80::1%25eth0])
  const ip = stripIpv6BracketsAndZone(rawIp).toLowerCase();
  if (net.isIP(ip) !== 6) return null;

  // Handle embedded IPv4 at the end (e.g. ::ffff:127.0.0.1)
  let working = ip;
  const lastColon = working.lastIndexOf(":");
  if (lastColon !== -1 && working.slice(lastColon + 1).includes(".")) {
    const ipv4Part = working.slice(lastColon + 1);
    const octets = parseIpv4Octets(ipv4Part);
    if (!octets) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    working = `${working.slice(0, lastColon)}:${high}:${low}`;
  }

  const doubleColonParts = working.split("::");
  if (doubleColonParts.length > 2) return null;

  if (doubleColonParts.length === 2) {
    const left = doubleColonParts[0] ? doubleColonParts[0].split(":") : [];
    const right = doubleColonParts[1] ? doubleColonParts[1].split(":") : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    const full = [...left, ...Array(missing).fill("0"), ...right];
    if (full.length !== 8) return null;
    return full.map((hexGroup) => Number.parseInt(hexGroup, 16));
  }

  const groups = working.split(":");
  if (groups.length !== 8) return null;
  return groups.map((hexGroup) => Number.parseInt(hexGroup, 16));
}

function ipv4FromTwoGroups(highGroup: number, lowGroup: number): string {
  const firstOctet = (highGroup >> 8) & 0xff;
  const secondOctet = highGroup & 0xff;
  const thirdOctet = (lowGroup >> 8) & 0xff;
  const fourthOctet = lowGroup & 0xff;
  return `${firstOctet}.${secondOctet}.${thirdOctet}.${fourthOctet}`;
}

/**
 * Extract the embedded IPv4 dotted-quad if `ip` is an IPv4-mapped, IPv4-compatible,
 * NAT64 (`64:ff9b::/96`), or 6to4 (`2002::/16`) IPv6 address.
 */
function extractEmbeddedIpv4(ip: string): string | null {
  const groups = parseIpv6Groups(ip);
  if (!groups) return null;

  // 1. ::ffff:0:0/96 (IPv4-mapped) or ::/96 (IPv4-compatible, excluding :: and ::1)
  const isAllZeroPrefix =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0;
  if (
    isAllZeroPrefix &&
    (groups[5] === 0xffff || (groups[5] === 0 && (groups[6] !== 0 || groups[7] > 1)))
  ) {
    return ipv4FromTwoGroups(groups[6], groups[7]);
  }

  // 2. 64:ff9b::/96 (NAT64 Well-Known Prefix)
  if (
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0
  ) {
    return ipv4FromTwoGroups(groups[6], groups[7]);
  }

  // 3. 2002::/16 (6to4 prefix — groups[1] and groups[2] hold the 32-bit IPv4 address)
  if (groups[0] === 0x2002) {
    return ipv4FromTwoGroups(groups[1], groups[2]);
  }

  return null;
}

/**
 * Check if an IP address is unconditionally blocked (cloud metadata, link-local,
 * unspecified `0.0.0.0/8` / `::`, or multicast/broadcast).
 * This block cannot be overridden even with `allowPrivateNetwork: true`.
 */
export function isUnconditionallyBlockedIp(rawIp: string): { blocked: boolean; reason?: string } {
  const cleanIp = stripIpv6BracketsAndZone(rawIp);

  const embeddedV4 = extractEmbeddedIpv4(cleanIp);
  if (embeddedV4) {
    return isUnconditionallyBlockedIp(embeddedV4);
  }

  const ipVersion = net.isIP(cleanIp);
  if (ipVersion === 4) {
    const octets = parseIpv4Octets(cleanIp);
    if (!octets) return { blocked: true, reason: "Malformed IPv4 address" };
    const [firstOctet, secondOctet, thirdOctet, fourthOctet] = octets;

    // 169.254.0.0/16 — Link-local and AWS/GCP/Azure/DigitalOcean instance metadata (169.254.169.254)
    if (firstOctet === 169 && secondOctet === 254) {
      return {
        blocked: true,
        reason: `IPv4 link-local / cloud metadata address (${cleanIp} in 169.254.0.0/16) is unconditionally blocked.`,
      };
    }
    // 100.100.100.200 — Alibaba Cloud metadata endpoint
    if (firstOctet === 100 && secondOctet === 100 && thirdOctet === 100 && fourthOctet === 200) {
      return {
        blocked: true,
        reason: `Cloud metadata address (${cleanIp}) is unconditionally blocked.`,
      };
    }
    // 0.0.0.0/8 — Unspecified / "this" network (often routes to localhost/loopback on OS kernels)
    if (firstOctet === 0) {
      return {
        blocked: true,
        reason: `Unspecified address (${cleanIp} in 0.0.0.0/8) is unconditionally blocked.`,
      };
    }
    // 224.0.0.0/4 (multicast) and 255.255.255.255 (broadcast)
    if (firstOctet >= 224) {
      return {
        blocked: true,
        reason: `Multicast/reserved/broadcast address (${cleanIp}) is unconditionally blocked.`,
      };
    }
    return { blocked: false };
  }

  if (ipVersion === 6) {
    const groups = parseIpv6Groups(cleanIp);
    if (!groups) return { blocked: true, reason: "Malformed IPv6 address" };

    // ::/128 — Unspecified IPv6 address
    if (groups.every((hexGroup) => hexGroup === 0)) {
      return {
        blocked: true,
        reason: `Unspecified IPv6 address (::/128) is unconditionally blocked.`,
      };
    }
    // fd00:ec2::254 — AWS IMDSv2 IPv6 endpoint
    if (
      groups[0] === 0xfd00 &&
      groups[1] === 0x0ec2 &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0 &&
      groups[5] === 0 &&
      groups[6] === 0 &&
      groups[7] === 0x0254
    ) {
      return {
        blocked: true,
        reason: `AWS IPv6 instance metadata endpoint (fd00:ec2::254) is unconditionally blocked.`,
      };
    }
    // fe80::/10 — IPv6 link-local
    if ((groups[0] & 0xffc0) === 0xfe80) {
      return {
        blocked: true,
        reason: `IPv6 link-local address (${cleanIp} in fe80::/10) is unconditionally blocked.`,
      };
    }
    // ff00::/8 — IPv6 multicast
    if ((groups[0] & 0xff00) === 0xff00) {
      return {
        blocked: true,
        reason: `IPv6 multicast address (${cleanIp} in ff00::/8) is unconditionally blocked.`,
      };
    }
    return { blocked: false };
  }

  return { blocked: false };
}

/**
 * Check if an IP address is a loopback, RFC1918 private, CGNAT, or IPv6 Unique Local address.
 */
export function isPrivateOrLoopbackIp(rawIp: string): boolean {
  const cleanIp = stripIpv6BracketsAndZone(rawIp);

  const embeddedV4 = extractEmbeddedIpv4(cleanIp);
  if (embeddedV4) {
    return isPrivateOrLoopbackIp(embeddedV4);
  }

  const ipVersion = net.isIP(cleanIp);
  if (ipVersion === 4) {
    const octets = parseIpv4Octets(cleanIp);
    if (!octets) return true;
    const [firstOctet, secondOctet] = octets;

    // 127.0.0.0/8 — Loopback
    if (firstOctet === 127) return true;
    // 10.0.0.0/8 — RFC1918 private
    if (firstOctet === 10) return true;
    // 172.16.0.0/12 — RFC1918 private
    if (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) return true;
    // 192.168.0.0/16 — RFC1918 private
    if (firstOctet === 192 && secondOctet === 168) return true;
    // 100.64.0.0/10 — Carrier-Grade NAT / Tailscale / private mesh
    if (firstOctet === 100 && secondOctet >= 64 && secondOctet <= 127) return true;
    // 198.18.0.0/15 — Benchmarking private range
    if (firstOctet === 198 && (secondOctet === 18 || secondOctet === 19)) return true;

    return false;
  }

  if (ipVersion === 6) {
    const groups = parseIpv6Groups(cleanIp);
    if (!groups) return true;

    // ::1/128 — IPv6 loopback
    if (
      groups[0] === 0 &&
      groups[1] === 0 &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0 &&
      groups[5] === 0 &&
      groups[6] === 0 &&
      groups[7] === 1
    ) {
      return true;
    }

    // fc00::/7 (fc00::..fdff::) — IPv6 Unique Local Addresses (ULA)
    if ((groups[0] & 0xfe00) === 0xfc00) {
      return true;
    }

    return false;
  }

  return false;
}

/**
 * Check if a hostname is a known cloud metadata hostname (unconditionally blocked).
 */
export function isBlockedMetadataHost(hostname: string): boolean {
  const normalized = stripIpv6BracketsAndZone(hostname).toLowerCase();
  if (BLOCKED_METADATA_HOSTS.has(normalized)) return true;
  if (normalized.endsWith(".metadata.google.internal") || normalized.endsWith(".metadata.azure.internal")) {
    return true;
  }
  return false;
}

/**
 * Check if a hostname is a local/private domain (`localhost`, `*.localhost`, `*.local`, `*.internal`).
 */
export function isPrivateHost(hostname: string): boolean {
  const normalized = stripIpv6BracketsAndZone(hostname).toLowerCase();
  if (!normalized) return true;
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  ) {
    return true;
  }
  if (net.isIP(normalized) !== 0) {
    return isPrivateOrLoopbackIp(normalized);
  }
  return false;
}

export type DnsLookupFunction = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

const defaultDnsLookup: DnsLookupFunction = async (hostname: string) => {
  return await dns.lookup(hostname, { all: true, verbatim: true });
};

/**
 * Validate a target URL against scheme, cloud metadata blocklist, and private/loopback rules,
 * resolving DNS records to prevent DNS rebinding or dual-stack bypass.
 */
export async function validateTargetUrlAndResolve(
  rawUrl: string,
  options: {
    allowPrivateNetwork?: boolean;
    query?: Record<string, string | number | boolean>;
    dnsLookup?: DnsLookupFunction;
  } = {},
): Promise<UrlValidationResult> {
  const built = buildRequestUrl(rawUrl, options.query);
  if (!built.ok || !built.url) {
    return { ok: false, error: built.error ?? "Invalid URL" };
  }

  const urlObj = built.url;
  const redacted = redactUrl(urlObj.toString());
  const rawHost = stripIpv6BracketsAndZone(urlObj.hostname);
  const lowerHost = rawHost.toLowerCase();

  // 1. Unconditional cloud metadata hostname check
  if (isBlockedMetadataHost(lowerHost)) {
    return {
      ok: false,
      url: urlObj,
      redactedUrl: redacted,
      error: `Blocked: target hostname "${lowerHost}" is a cloud metadata endpoint and is unconditionally denied.`,
    };
  }

  // 2. Direct IP literal check
  const ipVersion = net.isIP(lowerHost);
  if (ipVersion !== 0) {
    const hardBlock = isUnconditionallyBlockedIp(lowerHost);
    if (hardBlock.blocked) {
      return {
        ok: false,
        url: urlObj,
        redactedUrl: redacted,
        error: `Blocked: ${hardBlock.reason}`,
      };
    }

    const isPrivate = isPrivateOrLoopbackIp(lowerHost);
    if (isPrivate && options.allowPrivateNetwork !== true) {
      return {
        ok: false,
        url: urlObj,
        redactedUrl: redacted,
        isPrivateTarget: true,
        error: `Blocked: target IP "${lowerHost}" is a private or loopback address. Pass \`allowPrivateNetwork: true\` to explicitly authorize private/local network requests.`,
      };
    }

    return {
      ok: true,
      url: urlObj,
      redactedUrl: redacted,
      resolvedAddresses: [lowerHost],
      isPrivateTarget: isPrivate,
    };
  }

  // 3. Hostname private suffix check before DNS resolution
  const hostIsPrivateName = isPrivateHost(lowerHost);
  if (hostIsPrivateName && options.allowPrivateNetwork !== true) {
    return {
      ok: false,
      url: urlObj,
      redactedUrl: redacted,
      isPrivateTarget: true,
      error: `Blocked: hostname "${lowerHost}" is a local/private hostname. Pass \`allowPrivateNetwork: true\` to explicitly authorize local/private network requests.`,
    };
  }

  // 4. Pre-flight DNS resolution of all A / AAAA records
  const lookupFn = options.dnsLookup ?? defaultDnsLookup;
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookupFn(rawHost);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      url: urlObj,
      redactedUrl: redacted,
      error: `DNS resolution failed for "${lowerHost}": ${msg}`,
    };
  }

  if (!records || records.length === 0) {
    return {
      ok: false,
      url: urlObj,
      redactedUrl: redacted,
      error: `DNS resolution returned no addresses for "${lowerHost}".`,
    };
  }

  const resolvedAddresses: string[] = [];
  let anyPrivateIp = hostIsPrivateName;

  for (const record of records) {
    const addr = record.address.trim();
    resolvedAddresses.push(addr);

    const hardBlock = isUnconditionallyBlockedIp(addr);
    if (hardBlock.blocked) {
      return {
        ok: false,
        url: urlObj,
        redactedUrl: redacted,
        resolvedAddresses,
        error: `Blocked: hostname "${lowerHost}" resolved to ${addr} — ${hardBlock.reason}`,
      };
    }

    if (isPrivateOrLoopbackIp(addr)) {
      anyPrivateIp = true;
      if (options.allowPrivateNetwork !== true) {
        return {
          ok: false,
          url: urlObj,
          redactedUrl: redacted,
          resolvedAddresses,
          isPrivateTarget: true,
          error: `Blocked: hostname "${lowerHost}" resolved to private/loopback IP "${addr}". Pass \`allowPrivateNetwork: true\` to explicitly authorize private/local network requests.`,
        };
      }
    }
  }

  return {
    ok: true,
    url: urlObj,
    redactedUrl: redacted,
    resolvedAddresses,
    isPrivateTarget: anyPrivateIp,
  };
}

/**
 * Strip sensitive authentication and cookie headers when a safe-fetch redirect changes origin
 * (`protocol + host + port`) or downgrades from `https:` to `http:`.
 */
export function sanitizeHeadersForRedirect(
  currentUrl: URL,
  nextUrl: URL,
  headers: Record<string, string>,
): { headers: Record<string, string>; strippedHeaders: string[]; originChanged: boolean; protocolDowngraded: boolean } {
  const originChanged = currentUrl.origin !== nextUrl.origin;
  const protocolDowngraded = currentUrl.protocol === "https:" && nextUrl.protocol === "http:";

  if (!originChanged && !protocolDowngraded) {
    return { headers: { ...headers }, strippedHeaders: [], originChanged: false, protocolDowngraded: false };
  }

  const sanitized: Record<string, string> = {};
  const strippedHeaders: string[] = [];

  for (const [headerName, headerValue] of Object.entries(headers)) {
    const isHostHeaderOnOriginChange = originChanged && headerName.trim().toLowerCase() === "host";
    if (isSensitiveHeaderName(headerName) || isHostHeaderOnOriginChange) {
      strippedHeaders.push(headerName);
    } else {
      sanitized[headerName] = headerValue;
    }
  }

  return {
    headers: sanitized,
    strippedHeaders,
    originChanged,
    protocolDowngraded,
  };
}

/**
 * Enforce defense-in-depth authorization for:
 *  - Read-only specialist agents attempting private network access or insecure TLS
 *  - `allowPrivateNetwork: true`, `tls.rejectUnauthorized: false`,
 *    or mid-redirect escalations (redirect to private IP or HTTPS→HTTP downgrade)
 * safe-fetch only supports GET/HEAD/OPTIONS, so no mutating-method confirmation exists.
 */
export async function ensureFetchAuthorized(options: {
  params: FetchInputParams;
  method: HttpMethod;
  targetUrl: string;
  isPrivateTarget: boolean;
  isRedirectHop?: boolean;
  /** @deprecated Unused — retained for backward-compatible callers; redirect auth depends on `isPrivateTarget`/`protocolDowngraded` only. TODO(remove): delete this field once external callers are confirmed migrated. */
  originChanged?: boolean;
  protocolDowngraded?: boolean;
  ctx?: ExtensionContext;
  signal?: AbortSignal;
}): Promise<{ allowed: boolean; reason?: string }> {
  const {
    params,
    method,
    targetUrl,
    isPrivateTarget,
    isRedirectHop = false,
    protocolDowngraded = false,
    ctx,
    signal,
  } = options;

  const activeAgent = (process.env.PI_AGENT_NAME ?? "").trim();
  const privateNetRequested = params.allowPrivateNetwork === true || isPrivateTarget;
  const insecureTlsRequested = params.tls?.rejectUnauthorized === false;

  // 1. Hard read-only specialist agent guard (defense-in-depth alongside agent frontmatter rules)
  // safe-fetch has no mutating methods; guard only private-network and insecure-TLS access.
  if (activeAgent && READ_ONLY_SPECIALIST_AGENTS.has(activeAgent)) {
    if (privateNetRequested) {
      return {
        allowed: false,
        reason: `Blocked: read-only agent "${activeAgent}" is not permitted to access private/loopback network targets.`,
      };
    }
    if (insecureTlsRequested) {
      return {
        allowed: false,
        reason: `Blocked: read-only agent "${activeAgent}" is not permitted to disable TLS certificate verification (rejectUnauthorized=false).`,
      };
    }
  }

  // 2. Check if interactive confirmation is required
  // safe-fetch never mutates: only private-network, insecure-TLS, and
  // redirect-escalation (private target or HTTPS→HTTP downgrade) require confirmation.
  const needsConfirmation =
    privateNetRequested ||
    insecureTlsRequested ||
    (isRedirectHop && (isPrivateTarget || protocolDowngraded));

  if (!needsConfirmation) {
    return { allowed: true };
  }

  // If auto-approve is active for the session, allow without prompting
  if (isAutoApproveEnabled()) {
    return { allowed: true };
  }

  const redactedTarget = redactUrl(targetUrl);

  // For initial requests (not mid-redirect escalations), check if the permissions extension
  // already evaluated this call as `ask` on the `tool_call` hook (meaning the user already
  // approved the prompt before `execute()` was entered).
  if (!isRedirectHop && ctx) {
    try {
      const evalRes = evaluate("safe-fetch", params as unknown as Record<string, unknown>, ctx.cwd);
      if (evalRes.action === "ask") {
        // The `permissions` extension already prompted and the user approved on `tool_call`.
        return { allowed: true };
      }
    } catch {
      // Fall through to explicit in-tool confirmation if evaluation fails
    }
  }

  if (!ctx || !ctx.hasUI) {
    return {
      allowed: false,
      reason: `Blocked: safe-fetch ${method} ${redactedTarget} requires user confirmation (privateNetwork=${privateNetRequested}, insecureTls=${insecureTlsRequested}), but no interactive UI is available.`,
    };
  }

  const flags: string[] = [];
  if (privateNetRequested) flags.push("private/local network target");
  if (insecureTlsRequested) flags.push("TLS verification disabled (rejectUnauthorized=false)");
  if (isRedirectHop && protocolDowngraded) flags.push("redirect downgraded HTTPS → HTTP");
  if (isRedirectHop && isPrivateTarget) flags.push("redirect target is on private/loopback network");

  const title = isRedirectHop
    ? `Allow safe-fetch redirect to ${method} ${redactedTarget}?`
    : `Allow safe-fetch ${method} ${redactedTarget}?`;
  const message = `Flags: ${flags.join(", ")}\nTarget: ${redactedTarget}`;

  try {
    const confirmed = await ctx.ui.confirm(title, message, signal ? { signal } : undefined);
    if (!confirmed) {
      return {
        allowed: false,
        reason: `Denied by user: safe-fetch ${method} ${redactedTarget}`,
      };
    }
    return { allowed: true };
  } catch {
    return {
      allowed: false,
      reason: `Denied (confirmation aborted): safe-fetch ${method} ${redactedTarget}`,
    };
  }
}
