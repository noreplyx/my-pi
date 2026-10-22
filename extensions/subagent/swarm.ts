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

async function dirSizeBytes(dir: string): Promise<number> {
	let total = 0;
	let entries: fs.Dirent[] = [];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const e of entries) {
		const p = path.join(dir, e.name);
		try {
			if (e.isDirectory()) total += await dirSizeBytes(p);
			else total += (await fs.promises.stat(p)).size;
		} catch {
			/* skipped */
		}
	}
	return total;
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
			out.push({ runId: e, swarmDir, mtimeMs: st.mtimeMs, sizeBytes: await dirSizeBytes(swarmDir) });
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
 * newest `keepLastN` (dry-run by default).
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
		if (!isActive && isOld && !isNewest) {
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
