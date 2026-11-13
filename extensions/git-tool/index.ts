/**
 * git-tool — single unified git extension tool with `op` dispatch.
 *
 * Entry point (global): C:/Users/Tanut/.pi/agent/extensions/git-tool/index.ts
 * Zero npm deps (node builtins + host-provided pi modules only).
 * Spawn via execFile argv-only, shell:false, structured JSON, dry-run+confirm
 * writes, argv blocklist, cwd jail, bash warn+redirect, slash /git-tool.
 *
 * Docs fulfilled (see pi-coding-agent/docs/extensions.md):
 * - pi.registerTool (Custom Tools) with Type.Object closed schema
 * - pi.on("tool_call") + isToolCallEventType("bash", event) interceptor
 * - ctx.ui.confirm / ctx.ui.notify / ctx.ui.setStatus
 * - pi.appendEntry("git-tool-audit") session audit
 * - pi.registerCommand("git-tool") slash command sharing the same core
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolve } from "node:path";
import { GitToolError, isDirtyTree, jailCwd } from "./guard.ts";
import { READ_OPS, assertArgvSafe, assertCleanTreeIfNeeded, buildArgv, isWriteOp, timeoutFor, type GitParams, type Op } from "./ops.ts";
import { firstLine, parseBranches, parseLog, parseRemotes, parseStashList, parseStatusPorcelain } from "./parsers.ts";
import { runGit } from "./runner.ts";

const OpEnum = StringEnum([
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
] as const);

const GitToolParams = Type.Object(
  {
    op: OpEnum,
    cwd: Type.Optional(Type.String({ description: "Working directory (jailed inside session cwd)." })),
    paths: Type.Optional(Type.Array(Type.String(), { description: "File paths for add/diff/log." })),
    message: Type.Optional(Type.String({ description: "Message for commit/stash-push/tag-create." })),
    branch: Type.Optional(Type.String({ description: "Branch name for branch-create/delete, push." })),
    target: Type.Optional(Type.String({ description: "Target for checkout/merge/rebase/worktree/branch-create/show/reset/cherry-pick." })),
    remote: Type.Optional(Type.String({ description: "Remote name for fetch/push." })),
    ref: Type.Optional(Type.String({ description: "Ref for show/log/cherry-pick/reset/worktree-add." })),
    range: Type.Optional(Type.String({ description: "Revision range for log (e.g. main..HEAD)." })),
    limit: Type.Optional(Type.Integer({ description: "Max log entries (default 20, max 200).", minimum: 1, maximum: 200 })),
    tag: Type.Optional(Type.String({ description: "Tag name for tag-create." })),
    stashRef: Type.Optional(Type.String({ description: 'Stash ref for pop/apply (e.g. "stash@{0}").' })),
    resetMode: Type.Optional(OpEnumResetMode()),
    dryRun: Type.Optional(Type.Boolean({ description: "Write gate: true (default) = preview only. Set false + confirm:true to execute.", default: true })),
    confirm: Type.Optional(Type.Boolean({ description: "Write gate: must be true with dryRun:false to execute.", default: false })),
  },
  { additionalProperties: false },
);

function OpEnumResetMode() {
  return Type.Union([Type.Literal("mixed"), Type.Literal("soft")], {
    description: "Reset mode allowlist (hard is blocked).",
  });
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Serialize mutating ops per resolved cwd so concurrent writes don't interleave. */
const writeChains = new Map<string, Promise<void>>();

function serializeWrite<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const chained = prev.then(() => gate);
  writeChains.set(key, chained.catch(() => undefined));
  return prev.then(fn).finally(release);
}

function fail(params: Partial<GitParams>, text: string, code: string, extra?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text }],
    details: { tool: "git-tool", op: params.op ?? "unknown", error: text, code, ...(extra ?? {}) },
    isError: true,
  };
}

function describeArgv(argv: readonly string[]): string {
  return `git ${argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
}

type Ui = {
  confirm: (title: string, body: string) => Promise<boolean>;
  notify: (message: string, level?: string) => void;
  setStatus: (key: string, text: string) => void;
};

type CoreCtx = {
  cwd: string;
  hasUI: boolean;
  ui: Ui;
  signal?: AbortSignal;
};

async function core(params: GitParams, ctx: CoreCtx, audit: (data: Record<string, unknown>) => void): Promise<ToolResult> {
  const t0 = Date.now();
  const op = params.op as Op;
  let cwd: string;
  try {
    cwd = jailCwd(params.cwd, ctx.cwd);
  } catch (e) {
    const msg = e instanceof GitToolError ? e.message : String(e);
    return fail(params, msg, "OUTSIDE_TRUST_ROOT", { trustRoot: ctx.cwd });
  }

  let argv: string[];
  try {
    argv = buildArgv(params);
    assertArgvSafe(op, argv);
  } catch (e) {
    const code = e instanceof GitToolError ? e.code : "GIT_FAILED";
    return fail(params, e instanceof Error ? e.message : String(e), code, { cwd });
  }

  const dryRun = params.dryRun ?? (isWriteOp(op) ? true : false);
  const confirm = params.confirm ?? false;
  const annotations = isWriteOp(op)
    ? { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    : { readOnlyHint: true, destructiveHint: false, idempotentHint: true };

  // Read ops run directly; writes need dryRun:false + confirm:true + UI confirm.
  if (isWriteOp(op)) {
    if (dryRun !== false) {
      const text = `Dry-run preview (no mutation):\n${describeArgv(argv)}\nRe-run with dryRun:false + confirm:true to execute.`;
      audit({ op, cwd, argv, dryRun: true, executed: false, annotations });
      return {
        content: [{ type: "text", text }],
        details: { tool: "git-tool", op, cwd, argv, dryRun: true, executed: false, annotations, elapsedMs: Date.now() - t0 },
        structuredContent: { argv, dryRun: true, executed: false },
      };
    }
    if (confirm !== true) {
      return fail(params, `Refused: ${op} with dryRun:false requires confirm:true.`, "USER_CANCELLED", { cwd, argv, annotations });
    }
    if (!ctx.hasUI) {
      return fail(params, `Refused: ${op} needs interactive confirmation (no UI in this mode).`, "USER_CANCELLED", { cwd, argv, annotations });
    }
    const ok = await ctx.ui.confirm("git-tool: confirm write", `${describeArgv(argv)}\n\ncwd: ${cwd}\nProceed?`);
    if (!ok) {
      audit({ op, cwd, argv, dryRun: false, executed: false, denied: true, annotations });
      return fail(params, `Cancelled by user: ${op} not executed.`, "USER_CANCELLED", { cwd, argv, annotations });
    }
  }

  const run = async (): Promise<ToolResult> => {
    ctx.ui.setStatus("git-tool", `git ${op}…`);
    try {
      // Dirty-tree gate for ops that need a clean tree (single pre-flight probe).
      try {
        await assertCleanTreeIfNeeded(op, cwd);
      } catch (e) {
        const code = e instanceof GitToolError ? e.code : "GIT_FAILED";
        return fail(params, e instanceof Error ? e.message : String(e), code, { cwd, argv, annotations });
      }
      const res = await runGit(argv, { cwd, timeoutMs: timeoutFor(op), signal: ctx.signal });
      const elapsedMs = Date.now() - t0;
      if (res.exitCode !== 0) {
        const text = `git ${op} failed (exit ${res.exitCode}):\n${firstLine(res.stderr || res.stdout, 4000)}`;
        audit({ op, cwd, argv, exitCode: res.exitCode, executed: true, isError: true, annotations, elapsedMs });
        return {
          content: [{ type: "text", text }],
          details: { tool: "git-tool", op, cwd, argv, exitCode: res.exitCode, stderr: res.stderr.slice(0, 4000), truncated: res.truncated, annotations, elapsedMs },
          isError: true,
        };
      }
      const shaped = shapeSuccess(op, res.stdout, res.stderr, { cwd, argv, truncated: res.truncated, annotations, elapsedMs });
      audit({ op, cwd, argv, exitCode: 0, executed: true, annotations, elapsedMs });
      return shaped;
    } catch (e) {
      const code = e instanceof GitToolError ? e.code : "GIT_FAILED";
      const msg = e instanceof Error ? e.message : String(e);
      audit({ op, cwd, argv, executed: false, isError: true, code, annotations, elapsedMs: Date.now() - t0 });
      return fail(params, msg, code, { cwd, argv, annotations });
    } finally {
      ctx.ui.setStatus("git-tool", "");
    }
  };

  if (isWriteOp(op)) return serializeWrite(cwd.toLowerCase(), run);
  return run();
}

function shapeSuccess(
  op: Op,
  stdout: string,
  stderr: string,
  meta: { cwd: string; argv: string[]; truncated: boolean; annotations: Record<string, boolean>; elapsedMs: number },
): ToolResult {
  const base = { tool: "git-tool", op, cwd: meta.cwd, argv: meta.argv, exitCode: 0, truncated: meta.truncated, annotations: meta.annotations, elapsedMs: meta.elapsedMs };
  switch (op) {
    case "status": {
      const parsed = parseStatusPorcelain(stdout);
      const files = parsed.files.map((f) => `${f.xy} ${f.path}`).join("\n") || "(clean)";
      const text = `Branch ${parsed.branch} (ahead ${parsed.ahead}, behind ${parsed.behind}), ${parsed.files.length} changed:\n${files}${meta.truncated ? "\n… truncated" : ""}`;
      return {
        content: [{ type: "text", text }],
        details: { ...base, branch: parsed.branch, files: parsed.files, ahead: parsed.ahead, behind: parsed.behind },
        structuredContent: { branch: parsed.branch, files: parsed.files },
      };
    }
    case "log": {
      const entries = parseLog(stdout);
      const text = entries.length === 0 ? "(no commits)" : entries.map((e) => `${e.hash.slice(0, 8)} ${e.date} ${e.author}: ${e.subject}`).join("\n");
      return {
        content: [{ type: "text", text }],
        details: { ...base, commits: entries },
        structuredContent: { commits: entries },
      };
    }
    case "branch-list": {
      const branches = parseBranches(stdout);
      const current = branches.find((b) => b.current)?.name ?? "unknown";
      const text = branches.map((b) => `${b.current ? "*" : " "} ${b.name}${b.upstream ? ` [${b.upstream}]` : ""}`).join("\n") || "(no branches)";
      return {
        content: [{ type: "text", text }],
        details: { ...base, branch: current, branches },
        structuredContent: { branches },
      };
    }
    case "remote-list": {
      const remotes = parseRemotes(stdout);
      const text = remotes.length === 0 ? "(no remotes)" : remotes.map((r) => `${r.name} ${r.url} (${r.direction})`).join("\n");
      return { content: [{ type: "text", text }], details: { ...base, remotes }, structuredContent: { remotes } };
    }
    case "stash-list": {
      const stashes = parseStashList(stdout);
      const text = stashes.length === 0 ? "(no stashes)" : stashes.map((s) => `${s.ref}: ${s.message}`).join("\n");
      return { content: [{ type: "text", text }], details: { ...base, stashes }, structuredContent: { stashes } };
    }
    case "diff": {
      const text = stdout.trim().length === 0 ? "(no diff)" : stdout.slice(0, 12000);
      return { content: [{ type: "text", text }], details: { ...base, diffChars: stdout.length } };
    }
    default: {
      const out = (stdout.trim() || stderr.trim() || `(git ${op} ok)`).slice(0, 12000);
      return { content: [{ type: "text", text: out }], details: { ...base, branch: currentBranchHint(stdout) } };
    }
  }
}

function currentBranchHint(_stdout: string): string | undefined {
  return undefined;
}

function parseCommandArgs(raw: string): Partial<GitParams> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as Partial<GitParams>;
    } catch {
      return { message: trimmed };
    }
  }
  const tokens = trimmed.split(/\s+/);
  const maybeOp = tokens[0].toLowerCase().replace(/^\/+/, "");
  const rest = tokens.slice(1).join(" ");
  const out: Partial<GitParams> = {};
  const knownOps: ReadonlySet<string> = READ_OPS;
  void knownOps;
  // Accept any registered op token; unknown tokens become a message hint.
  (out as Record<string, unknown>).op = maybeOp;
  if (rest) {
    // Heuristic: single positional fills the most likely field for that op.
    if (["commit", "stash-push", "tag-create"].includes(maybeOp)) out.message = rest;
    else if (["checkout", "merge", "rebase", "reset", "cherry-pick", "show", "worktree-remove", "branch-delete"].includes(maybeOp)) out.target = rest;
    else if (["branch-create"].includes(maybeOp)) out.branch = rest;
    else if (["worktree-add"].includes(maybeOp)) out.target = rest;
    else out.message = rest;
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  const execute = async (
    _toolCallId: string,
    rawParams: unknown,
    signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: {
      cwd: string;
      hasUI: boolean;
      ui: { confirm: (t: string, b: string) => Promise<boolean>; notify: (m: string, l?: string) => void; setStatus: (k: string, s: string) => void };
    },
  ): Promise<ToolResult> => {
    const params = rawParams as GitParams;
    const coreCtx: CoreCtx = {
      cwd: typeof ctx.cwd === "string" ? ctx.cwd : resolve("."),
      hasUI: ctx.hasUI,
      ui: {
        confirm: (t, b) => ctx.ui.confirm(t, b),
        notify: (m, l) => (ctx.ui.notify as (message: string, level: "info" | "warning" | "error") => void)(m, (l as "info" | "warning" | "error") ?? "info"),
        setStatus: (k, s) => ctx.ui.setStatus(k, s),
      },
      signal,
    };
    const result = await core(params, coreCtx, (data) => {
      pi.appendEntry("git-tool-audit", { at: new Date().toISOString(), params: { op: params.op }, ...data });
    });
    void isDirtyTree;
    return result;
  };

  pi.registerTool({
    name: "git-tool",
    label: "Git Tool",
    description: [
      "Unified git operations via allowlisted argv (no shell).",
      "Read ops (no confirm): status, diff, log, show, branch-list, remote-list, stash-list, tag-list, worktree-list.",
      "Write ops (dryRun preview by default; execute with dryRun:false + confirm:true + UI confirm): add, commit, branch-create, branch-delete, checkout, fetch, pull --ff-only, push, stash-push, stash-pop, stash-apply, tag-create, reset (mixed|soft only), rebase, cherry-pick, merge, worktree-add, worktree-remove.",
      "Blocked pre-spawn: --force, --hard, clean, branch -D on main/master, --upload-pack, --exec, config --global. Cwd is jailed inside the session directory.",
    ].join(" "),
    parameters: GitToolParams,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    execute: execute as never,
    renderCall: ((args: Partial<GitParams>, theme: Theme, _context: unknown) => {
      const a = args as Partial<GitParams>;
      let text = theme.fg("toolTitle", theme.bold("git-tool ")) + theme.fg("accent", String(a.op ?? "?"));
      if (a.branch) text += theme.fg("muted", ` branch=${a.branch}`);
      if (a.target) text += theme.fg("muted", ` target=${a.target}`);
      if (a.message) text += `\n  ${theme.fg("dim", a.message.split("\n")[0].slice(0, 80))}`;
      if ((a as { dryRun?: boolean }).dryRun !== false && a.op && isWriteOp(String(a.op))) text += theme.fg("accent", " [dry-run]");
      return new Text(text, 0, 0);
    }) as never,
    renderResult: ((
      result: { content: Array<{ type?: string; text?: string }>; details?: { op?: string; exitCode?: number; truncated?: boolean; dryRun?: boolean; error?: string }; isError?: boolean },
      { expanded }: { expanded?: boolean },
      theme: Theme,
      _context: unknown,
    ) => {
      const d = result.details ?? {};
      const first = result.content[0];
      const body = first?.type === "text" ? String(first.text ?? "") : "(no output)";
      const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      let header = `${icon} ${theme.fg("toolTitle", theme.bold("git-tool"))}`;
      if (d.op) header += ` ${theme.fg("accent", String(d.op))}`;
      if (typeof d.exitCode === "number") header += theme.fg("muted", ` (exit=${d.exitCode}${d.truncated ? ", truncated" : ""})`);
      if (d.dryRun) header += theme.fg("muted", " [dry-run]");
      const textOut = expanded
        ? `${header}\n${theme.fg("toolOutput", body)}`
        : `${header}\n${theme.fg("toolOutput", body.split("\n").slice(0, 12).join("\n"))}`;
      return new Text(textOut, 0, 0);
    }) as never,
  });

  // Bash warn + redirect: nudge the model toward git-tool without blocking.
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return undefined;
    const command = String(event.input.command ?? "");
    if (/\bgit\b/.test(command)) {
      ctx.ui.notify("Use git-tool instead of bash git (allowlisted argv, cwd jail, audit).", "warning");
      return { block: false };
    }
    return undefined;
  });

  // Slash command sharing the same core: /git-tool <op> [args...] or /git-tool {json}
  pi.registerCommand("git-tool", {
    description: "Run git-tool op: /git-tool <op> [message/target] or /git-tool {\"op\":\"status\"}",
    handler: async (args, ctx) => {
      const parsed = parseCommandArgs(args ?? "");
      if (!parsed.op) {
        ctx.ui.notify('Usage: /git-tool <op> [args...] — e.g. /git-tool status, /git-tool log, /git-tool commit "msg"', "info");
        return;
      }
      const params = { dryRun: isWriteOp(String(parsed.op)) ? true : undefined, ...parsed } as GitParams;
      const coreCtx: CoreCtx = {
        cwd: ctx.cwd,
        hasUI: ctx.hasUI,
        ui: {
          confirm: (t, b) => ctx.ui.confirm(t, b),
          notify: (m, l) => (ctx.ui.notify as (message: string, level: "info" | "warning" | "error") => void)(m, (l as "info" | "warning" | "error") ?? "info"),
          setStatus: (k, s) => ctx.ui.setStatus(k, s),
        },
        signal: ctx.signal ?? undefined,
      };
      const result = await core(params, coreCtx, (data) => {
        pi.appendEntry("git-tool-audit", { at: new Date().toISOString(), via: "command", params: { op: params.op }, ...data });
      });
      const first = result.content[0];
      ctx.ui.notify(first?.type === "text" ? String(first.text).slice(0, 2000) : `(git-tool ${params.op} done)`, result.isError ? "error" : "info");
    },
  });
}
