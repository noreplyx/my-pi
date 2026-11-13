import { GitToolError, NEEDS_CLEAN_TREE, blockedReason, isProtectedBranch } from "./guard.ts";
import { FETCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, runGit } from "./runner.ts";

/** Canonical op list (single unified `op` param). */
export const OPS = [
  "status",
  "diff",
  "log",
  "show",
  "branch-list",
  "remote-list",
  "stash-list",
  "tag-list",
  "worktree-list",
  "add",
  "commit",
  "branch-create",
  "branch-delete",
  "checkout",
  "fetch",
  "pull",
  "push",
  "stash-push",
  "stash-pop",
  "stash-apply",
  "tag-create",
  "reset",
  "rebase",
  "cherry-pick",
  "merge",
  "worktree-add",
  "worktree-remove",
] as const;

export type Op = (typeof OPS)[number];

/** Read-only ops execute directly without confirmation prompts. */
export const READ_OPS: ReadonlySet<string> = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch-list",
  "remote-list",
  "stash-list",
  "tag-list",
  "worktree-list",
]);

export type GitParams = {
  op: Op;
  cwd?: string;
  paths?: string[];
  message?: string;
  branch?: string;
  target?: string;
  remote?: string;
  ref?: string;
  range?: string;
  limit?: number;
  tag?: string;
  stashRef?: string;
  resetMode?: "mixed" | "soft";
  dryRun?: boolean;
  confirm?: boolean;
};

function need(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GitToolError("GIT_FAILED", `Missing required field: ${name}`);
  }
}

function assertNoOptionSmuggling(values: Array<string | undefined>): void {
  for (const v of values) {
    if (v && v.startsWith("-")) {
      throw new GitToolError("BLOCKED_FLAG", `Blocked: value "${v}" looks like a CLI flag.`);
    }
  }
}

function assertPathsSafe(paths: string[] | undefined): void {
  if (!paths) return;
  for (const p of paths) {
    if (p.startsWith("-")) throw new GitToolError("BLOCKED_FLAG", `Blocked path flag: ${p}`);
    if (p.includes("\0")) throw new GitToolError("BLOCKED_FLAG", "Blocked: NUL byte in path.");
  }
}

/** Build final argv for an op. Never includes a shell; flags are fixed allowlist only. */
export function buildArgv(p: GitParams): string[] {
  assertPathsSafe(p.paths);
  assertNoOptionSmuggling([p.branch, p.target, p.remote, p.ref, p.range, p.tag, p.stashRef]);
  switch (p.op) {
    case "status":
      return ["status", "--short", "--branch"];
    case "diff":
      return p.paths && p.paths.length > 0
        ? ["diff", "--", ...p.paths]
        : ["diff"];
    case "log": {
      const argv = ["log", "--pretty=format:%H%x1f%s%x1f%an%x1f%ad", "--date=short"];
      const n = p.limit ?? 20;
      argv.push(`-n${Math.max(1, Math.min(200, n))}`);
      if (p.range) argv.push(p.range);
      else if (p.ref) argv.push(p.ref);
      if (p.paths && p.paths.length > 0) argv.push("--", ...p.paths);
      return argv;
    }
    case "show": {
      need(p.ref ?? p.target, "ref (commit/tag/HEAD) for show");
      return ["show", "--stat", "--oneline", (p.ref ?? p.target) as string];
    }
    case "branch-list":
      return ["branch", "--all", "--verbose"];
    case "remote-list":
      return ["remote", "--verbose"];
    case "stash-list":
      return ["stash", "list"];
    case "tag-list":
      return ["tag", "--list"];
    case "worktree-list":
      return ["worktree", "list", "--porcelain"];
    case "add": {
      if (!p.paths || p.paths.length === 0)
        throw new GitToolError("GIT_FAILED", "add requires `paths` (files to stage).");
      return ["add", "--", ...p.paths];
    }
    case "commit": {
      need(p.message, "message for commit");
      return ["commit", "-m", p.message as string];
    }
    case "branch-create": {
      need(p.branch, "branch for branch-create");
      if (isProtectedBranch(p.branch as string))
        throw new GitToolError("PROTECTED_BRANCH", `Refused: "${p.branch}" is protected.`);
      return p.target
        ? ["branch", p.branch as string, p.target as string]
        : ["branch", p.branch as string];
    }
    case "branch-delete": {
      need(p.branch, "branch for branch-delete");
      if (isProtectedBranch(p.branch as string))
        throw new GitToolError("PROTECTED_BRANCH", `Refused: cannot delete protected branch "${p.branch}".`);
      return ["branch", "-d", p.branch as string];
    }
    case "checkout": {
      need(p.target ?? p.branch, "target (branch/commit) for checkout");
      return ["checkout", (p.target ?? p.branch) as string];
    }
    case "fetch":
      return p.remote ? ["fetch", p.remote] : ["fetch", "--all", "--prune"];
    case "pull":
      // Always fast-forward-only; never auto-merge via pull.
      return ["pull", "--ff-only"];
    case "push": {
      if (p.branch && isProtectedBranch(p.branch))
        throw new GitToolError("PROTECTED_BRANCH", `Refused: pushing directly to "${p.branch}" is protected.`);
      return p.remote && p.branch
        ? ["push", p.remote, p.branch]
        : p.remote
          ? ["push", p.remote]
          : ["push"];
    }
    case "stash-push":
      return p.message ? ["stash", "push", "-m", p.message] : ["stash", "push"];
    case "stash-pop":
      return p.stashRef ? ["stash", "pop", p.stashRef] : ["stash", "pop"];
    case "stash-apply":
      return p.stashRef ? ["stash", "apply", p.stashRef] : ["stash", "apply"];
    case "tag-create": {
      need(p.tag, "tag for tag-create");
      return p.message
        ? ["tag", "-a", p.tag as string, "-m", p.message as string]
        : ["tag", p.tag as string];
    }
    case "reset": {
      need(p.ref ?? p.target, "ref for reset (commit, e.g. HEAD~1)");
      const mode = p.resetMode ?? "mixed";
      if (mode !== "mixed" && mode !== "soft")
        throw new GitToolError("BLOCKED_FLAG", `Blocked reset mode: ${mode} (only mixed|soft allowed).`);
      return [`--${mode}`, (p.ref ?? p.target) as string].length > 0
        ? ["reset", `--${mode}`, (p.ref ?? p.target) as string]
        : ["reset", (p.ref ?? p.target) as string];
    }
    case "rebase": {
      need(p.target, "target for rebase (upstream branch)");
      return ["rebase", p.target as string];
    }
    case "cherry-pick": {
      need(p.ref ?? p.target, "ref for cherry-pick (commit sha)");
      return ["cherry-pick", (p.ref ?? p.target) as string];
    }
    case "merge": {
      need(p.target, "target for merge (source branch)");
      return ["merge", "--no-ff", p.target as string];
    }
    case "worktree-add": {
      need(p.target, "target (path) for worktree-add");
      if (p.branch) return ["worktree", "add", p.target as string, p.branch as string];
      if (p.ref) return ["worktree", "add", p.target as string, p.ref as string];
      return ["worktree", "add", p.target as string];
    }
    case "worktree-remove": {
      need(p.target, "target (path) for worktree-remove");
      return ["worktree", "remove", p.target as string];
    }
    default:
      throw new GitToolError("GIT_FAILED", `Unknown op: ${(p as { op: string }).op}`);
  }
}

/** Timeout per op: slow network ops get 120s, everything else 30s. */
export function timeoutFor(op: Op): number {
  return op === "fetch" || op === "pull" ? FETCH_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

/**
 * Enforce blocklist + protected branches + dirty-tree policy before spawn.
 * DIRTY_TREE is checked by the caller via porcelain (needs one git call);
 * this helper covers the pure-argv checks synchronously.
 */
export function assertArgvSafe(op: Op, argv: readonly string[]): void {
  const reason = blockedReason(argv);
  if (reason) throw new GitToolError("BLOCKED_FLAG", `Blocked: ${reason}`);
  void op;
}

/** True when op mutates state (needs confirm + audit + serialization). */
export function isWriteOp(op: string): boolean {
  return !READ_OPS.has(op);
}

/** Dirty-tree gate: refuses ops that need a clean tree when porcelain is non-empty. */
export async function assertCleanTreeIfNeeded(op: Op, cwd: string): Promise<void> {
  if (!NEEDS_CLEAN_TREE.has(op)) return;
  const probe = await runGit(["status", "--porcelain"], { cwd, timeoutMs: DEFAULT_TIMEOUT_MS });
  if (probe.exitCode === 0 && probe.stdout.trim().length > 0) {
    throw new GitToolError(
      "DIRTY_TREE",
      `Refusing ${op} with dirty worktree. Commit or stash changes first (git-tool stash-push).`,
    );
  }
}
