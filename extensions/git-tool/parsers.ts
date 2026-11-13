/** Small structured parsers: git porcelain -> model-friendly text + details. */

/** Unit separator used by `git log --pretty=format:%H%x1f%s%x1f%an%x1f%ad`. */
export const FIELD_SEP = "\x1f";

export type ParsedStatus = {
  branch: string;
  ahead: number;
  behind: number;
  files: Array<{ xy: string; path: string }>;
};

export function parseStatusBranch(line: string): {
  branch: string;
  ahead: number;
  behind: number;
} {
  // ## main...origin/main [ahead 2, behind 1]
  const m = /^##\s+([^\s.]+)(?:\.\.\.([^\s[]+))?(?:\s+\[(.+)\])?/.exec(line.trim());
  if (!m) return { branch: line.replace(/^##\s+/, "").trim() || "unknown", ahead: 0, behind: 0 };
  let ahead = 0;
  let behind = 0;
  const extra = m[3] ?? "";
  const a = /ahead\s+(\d+)/.exec(extra);
  const b = /behind\s+(\d+)/.exec(extra);
  if (a) ahead = Number(a[1]);
  if (b) behind = Number(b[1]);
  return { branch: m[1], ahead, behind };
}

export function parseStatusPorcelain(output: string): ParsedStatus {
  const lines = output.split("\n").filter((l) => l.length > 0);
  let branch = "unknown";
  let ahead = 0;
  let behind = 0;
  const files: ParsedStatus["files"] = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      const b = parseStatusBranch(line);
      branch = b.branch;
      ahead = b.ahead;
      behind = b.behind;
      continue;
    }
    if (line.length >= 4) {
      const xy = line.slice(0, 2);
      const path = line.slice(3).trim();
      if (path) files.push({ xy, path });
    }
  }
  return { branch, ahead, behind, files };
}

export type LogEntry = { hash: string; subject: string; author: string; date: string };

export function parseLog(output: string): LogEntry[] {
  return output
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .map((line) => {
      const [hash = "", subject = "", author = "", date = ""] = line.split(FIELD_SEP);
      return { hash, subject, author, date };
    })
    .filter((e) => e.hash.length > 0);
}

export type BranchEntry = { name: string; current: boolean; upstream: string };

export function parseBranches(output: string): BranchEntry[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((line) => {
      const current = line.startsWith("* ");
      const rest = current ? line.slice(2).trim() : line;
      const m = /^(\S+)\s*(?:\[([^\]]+)\])?/.exec(rest);
      return { name: m?.[1] ?? rest, current, upstream: m?.[2] ?? "" };
    });
}

export type RemoteEntry = { name: string; url: string; direction: string };

export function parseRemotes(output: string): RemoteEntry[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((line) => {
      const [name = "", url = "", direction = ""] = line.split(/\s+/);
      return { name, url: url.replace(/:[^/@\s]+@/g, ":***REDACTED***@"), direction };
    });
}

export type StashEntry = { ref: string; message: string };

export function parseStashList(output: string): StashEntry[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((line) => {
      const m = /^(stash@\{\d+\}):\s*(.*)$/.exec(line);
      return { ref: m?.[1] ?? line, message: m?.[2] ?? "" };
    });
}

export function firstLine(text: string, maxChars = 4000): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > maxChars ? `${one.slice(0, maxChars)}…` : one;
}
