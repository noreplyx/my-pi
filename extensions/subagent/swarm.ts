/**
 * File blackboard for hierarchical swarms.
 *
 * Layout (repo-local, gitignored):
 *   <cwd>/.swarm/<runId>/tasks.jsonl
 *   <cwd>/.swarm/<runId>/inbox/<workerId>.jsonl
 *   <cwd>/.swarm/<runId>/outbox.jsonl
 *   <cwd>/.swarm/<runId>/done/<workerId>.md
 *
 * All writes go through withFileMutationQueue (per-path mutex).
 * Workers use plain read/write/bash tools against these paths.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { SWARM_DIR_NAME, SWARM_GC_DEFAULT_DAYS, SWARM_GC_KEEP_LAST, isValidRunId } from "./utils.ts";

export interface SwarmRun {
	runId: string;
	swarmDir: string;
}

export function swarmRunDir(cwd: string, runId: string): string {
	return path.join(cwd, SWARM_DIR_NAME, runId);
}

export async function createSwarmRun(cwd: string, runId: string): Promise<SwarmRun> {
	if (!isValidRunId(runId)) throw new Error(`invalid runId: ${runId}`);
	const swarmDir = swarmRunDir(cwd, runId);
	await fs.promises.mkdir(path.join(swarmDir, "inbox"), { recursive: true });
	await fs.promises.mkdir(path.join(swarmDir, "done"), { recursive: true });
	await withFileMutationQueue(path.join(swarmDir, "tasks.jsonl"), async () => {
		await fs.promises.writeFile(path.join(swarmDir, "tasks.jsonl"), "", { flag: "a" });
	});
	await withFileMutationQueue(path.join(swarmDir, "outbox.jsonl"), async () => {
		await fs.promises.writeFile(path.join(swarmDir, "outbox.jsonl"), "", { flag: "a" });
	});
	return { runId, swarmDir };
}

export async function appendTaskLedger(swarmDir: string, line: string): Promise<void> {
	const p = path.join(swarmDir, "tasks.jsonl");
	await withFileMutationQueue(p, async () => {
		await fs.promises.appendFile(p, line.endsWith("\n") ? line : `${line}\n`);
	});
}

export async function appendOutbox(swarmDir: string, line: string): Promise<void> {
	const p = path.join(swarmDir, "outbox.jsonl");
	await withFileMutationQueue(p, async () => {
		await fs.promises.appendFile(p, line.endsWith("\n") ? line : `${line}\n`);
	});
}

export interface SwarmManifest {
	runId: string;
	parentRunId?: string;
	goal: string;
	workers: Array<{ id: string; agent: string }>;
	status: "running" | "done" | "aborted";
	createdAt: string;
}

const MANIFEST_FILE = "manifest.json";
const CANCEL_FILE = "cancel.json";

export async function writeManifest(swarmDir: string, manifest: SwarmManifest): Promise<void> {
	const p = path.join(swarmDir, MANIFEST_FILE);
	await withFileMutationQueue(p, async () => {
		await fs.promises.writeFile(p, JSON.stringify(manifest, null, 2));
	});
}

export async function readManifest(swarmDir: string): Promise<SwarmManifest | null> {
	try {
		const raw = await fs.promises.readFile(path.join(swarmDir, MANIFEST_FILE), "utf-8");
		const v = JSON.parse(raw) as Partial<SwarmManifest>;
		if (typeof v.runId !== "string" || typeof v.goal !== "string" || !Array.isArray(v.workers)) return null;
		return {
			runId: v.runId,
			parentRunId: typeof v.parentRunId === "string" ? v.parentRunId : undefined,
			goal: v.goal,
			workers: v.workers.filter((w) => typeof w?.id === "string" && typeof w?.agent === "string"),
			status: v.status === "done" || v.status === "aborted" ? v.status : "running",
			createdAt: typeof v.createdAt === "string" ? v.createdAt : new Date(0).toISOString(),
		};
	} catch {
		return null;
	}
}

export async function updateManifestStatus(swarmDir: string, status: SwarmManifest["status"]): Promise<void> {
	const m = await readManifest(swarmDir);
	if (!m) return;
	m.status = status;
	await writeManifest(swarmDir, m);
}

/**
 * Validated outbox append: rejects empty from/body, defaults missing `to`,
 * caps body so one worker cannot blow up the ledger. Returns error string
 * instead of throwing so the orchestrator can surface it best-effort.
 */
export async function appendOutboxValidated(
	swarmDir: string,
	entry: { from: string; to?: string; body: string; ts?: string },
	maxBodyBytes = 8000,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const from = entry.from?.trim() ?? "";
	const body = entry.body ?? "";
	if (!from) return { ok: false, error: "outbox entry requires non-empty from" };
	if (!body.trim()) return { ok: false, error: "outbox entry requires non-empty body" };
	let capped = body;
	while (Buffer.byteLength(capped, "utf8") > maxBodyBytes && capped.length > 0) {
		capped = capped.slice(0, Math.max(0, capped.length - 256));
	}
	const line = JSON.stringify({
		ts: entry.ts ?? new Date().toISOString(),
		from,
		to: entry.to?.trim() || "all",
		body: capped,
	});
	await appendOutbox(swarmDir, line);
	return { ok: true };
}

export async function requestCancel(swarmDir: string, reason = "cancel requested"): Promise<void> {
	const p = path.join(swarmDir, CANCEL_FILE);
	await withFileMutationQueue(p, async () => {
		await fs.promises.writeFile(p, JSON.stringify({ ts: new Date().toISOString(), reason }));
	});
}

export async function isCancelled(swarmDir: string): Promise<boolean> {
	try {
		await fs.promises.access(path.join(swarmDir, CANCEL_FILE));
		return true;
	} catch {
		return false;
	}
}

/**
 * Fork-resume: create `<parentRunId>-rN` (first free N) carrying the parent
 * goal/worker specs in its manifest. The parent dir is never mutated.
 */
export async function forkSwarmRun(
	cwd: string,
	parentRunId: string,
): Promise<{ runId: string; swarmDir: string; parent: SwarmManifest } | { error: string }> {
	if (!isValidRunId(parentRunId)) return { error: `invalid parent runId: ${parentRunId}` };
	const parentDir = swarmRunDir(cwd, parentRunId);
	const parent = await readManifest(parentDir);
	if (!parent) {
		// Fall back to tasks.jsonl first line for runs created before manifests.
		try {
			const raw = await fs.promises.readFile(path.join(parentDir, "tasks.jsonl"), "utf-8");
			const first = raw.split("\n").find((l) => l.trim());
			if (!first) return { error: `parent run ${parentRunId} has no tasks` };
			const v = JSON.parse(first) as { goal?: string; workers?: Array<{ id: string; agent: string }> };
			if (typeof v.goal !== "string" || !Array.isArray(v.workers)) return { error: `parent run ${parentRunId} has no manifest` };
			const fallback: SwarmManifest = {
				runId: parentRunId,
				goal: v.goal,
				workers: v.workers,
				status: "running",
				createdAt: new Date().toISOString(),
			};
			return forkFromManifest(cwd, parentRunId, fallback);
		} catch {
			return { error: `parent run ${parentRunId} not found` };
		}
	}
	return forkFromManifest(cwd, parentRunId, parent);
}

async function forkFromManifest(
	cwd: string,
	parentRunId: string,
	parent: SwarmManifest,
): Promise<{ runId: string; swarmDir: string; parent: SwarmManifest } | { error: string }> {
	for (let n = 2; n < 100; n++) {
		const runId = `${parentRunId}-r${n}`;
		const dir = swarmRunDir(cwd, runId);
		try {
			await fs.promises.access(dir);
			continue;
		} catch {
			/* free */
		}
		const run = await createSwarmRun(cwd, runId);
		await writeManifest(run.swarmDir, {
			runId,
			parentRunId,
			goal: parent.goal,
			workers: parent.workers,
			status: "running",
			createdAt: new Date().toISOString(),
		});
		return { runId, swarmDir: run.swarmDir, parent };
	}
	return { error: `no free fork slot for ${parentRunId}` };
}

export async function readDoneFiles(swarmDir: string): Promise<Array<{ id: string; body: string }>> {
	const doneDir = path.join(swarmDir, "done");
	let entries: string[] = [];
	try {
		entries = await fs.promises.readdir(doneDir);
	} catch {
		return [];
	}
	entries.sort();
	const out: Array<{ id: string; body: string }> = [];
	for (const e of entries) {
		if (!e.endsWith(".md")) continue;
		try {
			const body = await fs.promises.readFile(path.join(doneDir, e), "utf-8");
			out.push({ id: e.slice(0, -3), body });
		} catch {
			/* skipped */
		}
	}
	return out;
}

export interface SwarmRunSummary {
	runId: string;
	swarmDir: string;
	mtimeMs: number;
	sizeBytes: number;
}

/** Walk a swarm run dir once, returning total bytes + max file mtime.
 * Reused by `listSwarmRuns` so `mtimeMs` reflects the newest file inside
 * (not the directory mtime, which is unreliable across filesystems). */
async function dirStats(dir: string): Promise<{ sizeBytes: number; maxMtimeMs: number }> {
	let total = 0;
	let maxMtime = 0;
	let entries: fs.Dirent[] = [];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return { sizeBytes: 0, maxMtimeMs: 0 };
	}
	for (const e of entries) {
		const p = path.join(dir, e.name);
		try {
			if (e.isDirectory()) {
				const sub = await dirStats(p);
				total += sub.sizeBytes;
				if (sub.maxMtimeMs > maxMtime) maxMtime = sub.maxMtimeMs;
			} else {
				const st = await fs.promises.stat(p);
				total += st.size;
				if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
			}
		} catch {
			/* skipped */
		}
	}
	return { sizeBytes: total, maxMtimeMs: maxMtime };
}

/** List all swarm runs under <cwd>/.swarm, newest first. */
export async function listSwarmRuns(cwd: string): Promise<SwarmRunSummary[]> {
	const root = path.join(cwd, SWARM_DIR_NAME);
	let entries: string[] = [];
	try {
		entries = await fs.promises.readdir(root);
	} catch {
		return [];
	}
	const out: SwarmRunSummary[] = [];
	for (const e of entries) {
		if (!isValidRunId(e)) continue;
		const swarmDir = path.join(root, e);
		try {
			const st = await fs.promises.stat(swarmDir);
			if (!st.isDirectory()) continue;
			const stats = await dirStats(swarmDir);
			// Effective mtime is the oldest evidence (dir mtime vs newest
			// file inside): a stale run is collectible even when its files
			// were recently touched, while truly-active runs stay safe via
			// the manifest `status==="running"` guard + `excludeRunId` in
			// `pruneSwarmRuns`. Falls back to dir mtime when empty/unreadable.
			const mtimeMs = stats.maxMtimeMs > 0 ? Math.min(st.mtimeMs, stats.maxMtimeMs) : st.mtimeMs;
			out.push({ runId: e, swarmDir, mtimeMs, sizeBytes: stats.sizeBytes });
		} catch {
			/* skipped */
		}
	}
	out.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return out;
}

export interface PruneSwarmRunsOptions {
	olderThanDays?: number;
	keepLastN?: number;
	dryRun?: boolean;
	/** Never delete this run (the currently executing swarm). */
	excludeRunId?: string;
}

export interface PruneSwarmRunsResult {
	deleted: string[];
	kept: string[];
	freedBytes: number;
	dryRun: boolean;
}

/**
 * GC for `.swarm/<runId>/` blackboards. Conservative by default: a run is
 * deleted only when it is BOTH older than `olderThanDays` AND outside the
 * newest `keepLastN` (dry-run by default). Runs with manifest
 * `status==="running"` are always kept, as is `excludeRunId` (the active
 * run).
 */
export async function pruneSwarmRuns(cwd: string, opts: PruneSwarmRunsOptions = {}): Promise<PruneSwarmRunsResult> {
	const olderThanDays = opts.olderThanDays ?? SWARM_GC_DEFAULT_DAYS;
	const keepLastN = opts.keepLastN ?? SWARM_GC_KEEP_LAST;
	const dryRun = opts.dryRun ?? true;
	const runs = await listSwarmRuns(cwd);
	const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
	const deleted: string[] = [];
	const kept: string[] = [];
	let freedBytes = 0;
	for (let i = 0; i < runs.length; i++) {
		const r = runs[i];
		const isNewest = i < keepLastN;
		const isOld = r.mtimeMs < cutoff;
		const isActive = opts.excludeRunId !== undefined && r.runId === opts.excludeRunId;
		if (isActive) {
			kept.push(r.runId);
			continue;
		}
		// Best-effort: never GC a run that still reports running.
		try {
			const manifest = await readManifest(r.swarmDir);
			if (manifest?.status === "running") {
				kept.push(r.runId);
				continue;
			}
		} catch {
			/* unreadable manifest → fall through to age checks */
		}
		if (isOld && !isNewest) {
			deleted.push(r.runId);
			freedBytes += r.sizeBytes;
			if (!dryRun) {
				try {
					await fs.promises.rm(r.swarmDir, { recursive: true, force: true });
				} catch {
					/* best-effort */
				}
			}
		} else {
			kept.push(r.runId);
		}
	}
	return { deleted, kept, freedBytes, dryRun };
}
