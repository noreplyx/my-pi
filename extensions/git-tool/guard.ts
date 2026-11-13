import { resolve, sep } from "node:path";

/** Typed git-tool error codes (parsers + runner + guard share these). */
export type GitErrorCode =
  | "NOT_A_REPO"
  | "NO_GIT_BINARY"
  | "BLOCKED_FLAG"
  | "OUTSIDE_TRUST_ROOT"
  | "PROTECTED_BRANCH"
  | "DIRTY_TREE"
  | "TIMEOUT"
  | "USER_CANCELLED"
  | "GIT_FAILED";

export class GitToolError extends Error {
  readonly code: GitErrorCode;
  constructor(code: GitErrorCode, message: string) {
    super(message);
    this.name = "GitToolError";
    this.code = code;
  }
}

/** Flags/patterns that must never reach spawn (checked pre-spawn, defense in depth). */
const BLOCKED_ARGV_TOKENS: readonly string[] = [
  "--force",
  "-f", // only meaningful alongside push/reset; checked contextually below
  "--hard",
  "--upload-pack",
  "--exec",
  "--upload-archive",
  "--global",
  "--system",
];

const BLOCKED_SUBCOMMANDS: readonly string[] = ["filter-branch", "filter-repo", "clean"];

const PROTECTED_BRANCHES: readonly string[] = ["main", "master"];

/** Exact argv token match (case-sensitive; git flags are case-sensitive). */
function hasExactToken(argv: readonly string[], token: string): boolean {
  return argv.includes(token);
}

function hasPrefixToken(argv: readonly string[], prefix: string): boolean {
  return argv.some((t) => t.startsWith(prefix));
}

/**
 * Pre-spawn blocklist. Returns a human-readable reason or null when allowed.
 * Operates on the final argv (no shell), so user input can never smuggle flags.
 */
export function blockedReason(argv: readonly string[]): string | null {
  const [sub, ...rest] = argv;
  void rest;
  if (BLOCKED_SUBCOMMANDS.includes(sub)) return `Blocked subcommand: git ${sub}`;
  if (hasExactToken(argv, "--hard")) return "Blocked flag: --hard (destructive reset)";
  if (hasExactToken(argv, "--force") || hasExactToken(argv, "--force-with-lease"))
    return "Blocked flag: --force (use explicit safe ops)";
  // Short -f is only dangerous for push/reset/branch; allow it elsewhere (e.g. harmless fetch -f? still block fetch -f to be safe).
  if (sub === "push" && hasExactToken(argv, "-f")) return "Blocked flag: -f (push --force)";
  if ((sub === "reset" || sub === "branch") && hasExactToken(argv, "-f"))
    return "Blocked flag: -f (destructive)";
  if (hasPrefixToken(argv, "--upload-pack=") || hasExactToken(argv, "--upload-pack"))
    return "Blocked flag: --upload-pack (arbitrary command execution)";
  if (hasExactToken(argv, "--exec") || hasPrefixToken(argv, "--exec="))
    return "Blocked flag: --exec (arbitrary command execution)";
  if (hasExactToken(argv, "--upload-archive") || hasPrefixToken(argv, "--upload-archive="))
    return "Blocked flag: --upload-archive (arbitrary command execution)";
  if (hasExactToken(argv, "config") || sub === "config") {
    if (hasExactToken(argv, "--global") || hasExactToken(argv, "--system"))
      return "Blocked flag: git config --global/--system (machine-wide mutation)";
  }
  if (hasExactToken(argv, "-D")) {
    const idx = argv.indexOf("-D");
    const victim = argv[idx + 1];
    if (victim && PROTECTED_BRANCHES.includes(victim.toLowerCase()))
      return `Blocked: branch -D on protected branch "${victim}"`;
  }
  // Generic exact-token sweep for remaining tokens (avoids substring false positives).
  for (const token of BLOCKED_ARGV_TOKENS) {
    if (token === "-f") continue; // handled contextually above
    if (token === "--global" || token === "--system") continue; // handled under config above
    if (hasExactToken(argv, token)) return `Blocked flag: ${token}`;
  }
  // Dangerous clean -fd / -fdx combos (we never generate clean, but block smuggled argv).
  if (sub === "clean" && (hasExactToken(argv, "-f") || hasExactToken(argv, "-fd") || hasExactToken(argv, "-fdx")))
    return "Blocked: git clean -f (destructive)";
  return null;
}

/** Returns true when argv passes the blocklist. */
export function isArgvAllowed(argv: readonly string[]): boolean {
  return blockedReason(argv) === null;
}

/** Protected branches that need extra care (delete/reset/force-push). */
export function isProtectedBranch(name: string): boolean {
  return PROTECTED_BRANCHES.includes(name.trim().toLowerCase());
}

/**
 * Jail a requested cwd inside the trust root (session cwd).
 * Windows-aware: case-insensitive comparison. Returns resolved absolute path.
 * Throws GitToolError(OUTSIDE_TRUST_ROOT) on escape.
 */
export function jailCwd(requestedCwd: string | undefined, trustRoot: string): string {
  const root = resolve(trustRoot);
  const candidate = requestedCwd ? resolve(root, requestedCwd) : root;
  const rootNorm = root.toLowerCase();
  const candNorm = candidate.toLowerCase();
  const inside = candNorm === rootNorm || candNorm.startsWith(rootNorm + sep.toLowerCase());
  if (!inside) {
    throw new GitToolError(
      "OUTSIDE_TRUST_ROOT",
      `Blocked: cwd "${requestedCwd}" escapes trust root "${trustRoot}". Stay inside the session directory.`,
    );
  }
  return candidate;
}

/** Redact tokens/secrets from text before returning to the model or logs. */
export function redactSecrets(text: string): string {
  return (
    text
      // GitHub / GitLab / Azure tokens
      .replace(/gh[pousr]_[A-Za-z0-9_]{10,}/g, "gh***REDACTED***")
      .replace(/glpat-[A-Za-z0-9_-]{8,}/g, "glpat-***REDACTED***")
      // password / token query params and basic-auth URLs
      .replace(/(https?:\/\/[^/\s:]+:)[^@\s]+@/g, "$1***REDACTED***@")
      .replace(/([?&](?:token|password|passwd|secret)=)[^&\s]+/gi, "$1***REDACTED***")
      // generic bearer lines
      .replace(/(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, "$1***REDACTED***")
  );
}

/** Ops that require a clean tree (dirty worktree is refused with DIRTY_TREE). */
export const NEEDS_CLEAN_TREE: ReadonlySet<string> = new Set([
  "checkout",
  "merge",
  "rebase",
  "cherry-pick",
  "pull",
  "reset",
]);

/** True when `git status --porcelain` output indicates a dirty tree. */
export function isDirtyTree(porcelain: string): boolean {
  return porcelain.trim().length > 0;
}
