import { execFile, type ExecException } from "node:child_process";
import { GitToolError, redactSecrets } from "./guard.ts";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const FETCH_TIMEOUT_MS = 120_000;
/** Combined stdout+stderr cap (1MB). Overflow kills the child and sets truncated:true. */
export const MAX_OUTPUT_BYTES = 1_000_000;

export type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
};

type RunOptions = {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

function isErrnoNoEnt(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: unknown }).code === "ENOENT"
  );
}

/** Spawn `git argv` with no shell. Rejects with typed GitToolError on infra failures. */
export function runGit(argv: readonly string[], opts: RunOptions): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<RunResult>((resolveRun, rejectRun) => {
    const child = execFile(
      "git",
      [...argv],
      {
        cwd: opts.cwd,
        timeout: timeoutMs,
        shell: false,
        windowsHide: true,
        maxBuffer: MAX_OUTPUT_BYTES,
        signal: opts.signal,
      },
      (error: ExecException | null, stdout: string | Buffer, stderr: string | Buffer) => {
        const out = typeof stdout === "string" ? stdout : String(stdout ?? "");
        const err = typeof stderr === "string" ? stderr : String(stderr ?? "");
        const redactedOut = redactSecrets(out).slice(0, MAX_OUTPUT_BYTES);
        const redactedErr = redactSecrets(err).slice(0, MAX_OUTPUT_BYTES);
        if (error) {
          if (isErrnoNoEnt(error)) {
            rejectRun(new GitToolError("NO_GIT_BINARY", "git binary not found on PATH."));
            return;
          }
          const nodeErr = error as { code?: unknown; killed?: boolean; signal?: unknown };
          // Timeout / abort are infra errors, not git failures.
          if (nodeErr.killed === true) {
            const aborted = opts.signal?.aborted === true;
            rejectRun(
              new GitToolError(
                aborted ? "USER_CANCELLED" : "TIMEOUT",
                aborted
                  ? `Cancelled: git ${argv[0]} aborted by user signal.`
                  : `Timeout: git ${argv[0]} exceeded ${timeoutMs}ms and was killed.`,
              ),
            );
            return;
          }
          const exitCode = typeof nodeErr.code === "number" ? nodeErr.code : 1;
          const combined = `${redactedOut}${redactedErr}`.toLowerCase();
          if (
            exitCode !== 0 &&
            (combined.includes("not a git repository") || combined.includes("not a git repo"))
          ) {
            rejectRun(new GitToolError("NOT_A_REPO", `Not a git repository (cwd="${opts.cwd}").`));
            return;
          }
          // Ordinary non-zero git exit: surface output, let callers set isError.
          resolveRun({
            stdout: redactedOut,
            stderr: redactedErr,
            exitCode,
            truncated:
              Buffer.byteLength(redactedOut) + Buffer.byteLength(redactedErr) >= MAX_OUTPUT_BYTES,
          });
          return;
        }
        resolveRun({
          stdout: redactedOut,
          stderr: redactedErr,
          exitCode: 0,
          truncated:
            Buffer.byteLength(redactedOut) + Buffer.byteLength(redactedErr) >= MAX_OUTPUT_BYTES,
        });
      },
    );
    // Defensive: execFile with `signal` already aborts; ensure kill on parent abort.
    if (opts.signal) {
      const onAbort = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore — child already exited */
        }
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
