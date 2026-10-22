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
import { SWARM_DIR_NAME, isValidRunId } from "./utils.ts";

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
