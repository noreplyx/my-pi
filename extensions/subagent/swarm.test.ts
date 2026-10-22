import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendOutbox, createSwarmRun, listSwarmRuns, pruneSwarmRuns, readDoneFiles } from "./swarm.ts";

async function mkRoot(): Promise<string> {
	return await fs.promises.mkdtemp(path.join(os.tmpdir(), "swarm-test-"));
}

describe("swarm blackboard", () => {
	test("concurrent appendOutbox keeps all lines", async () => {
		const root = await mkRoot();
		const run = await createSwarmRun(root, "swarm-20240101-120000-ab12");
		await Promise.all(Array.from({ length: 10 }, (_, i) => appendOutbox(run.swarmDir, JSON.stringify({ from: `w${i}` }))));
		const raw = await fs.promises.readFile(path.join(run.swarmDir, "outbox.jsonl"), "utf-8");
		expect(raw.trim().split("\n")).toHaveLength(10);
		await fs.promises.rm(root, { recursive: true, force: true });
	});

	test("readDoneFiles sorts by name", async () => {
		const root = await mkRoot();
		const run = await createSwarmRun(root, "swarm-20240101-120001-ab12");
		await fs.promises.writeFile(path.join(run.swarmDir, "done", "b.md"), "B");
		await fs.promises.writeFile(path.join(run.swarmDir, "done", "a.md"), "A");
		const done = await readDoneFiles(run.swarmDir);
		expect(done.map((d) => d.id)).toEqual(["a", "b"]);
		await fs.promises.rm(root, { recursive: true, force: true });
	});

	test("prune keeps newest + active, deletes old (dry-run default)", async () => {
		const root = await mkRoot();
		const mk = async (id: string, daysAgo: number) => {
			const run = await createSwarmRun(root, id);
			const t = new Date(Date.now() - daysAgo * 86400000);
			await fs.promises.utimes(run.swarmDir, t, t);
			return run;
		};
		const old1 = await mk("swarm-20240101-100000-aa11", 30);
		const old2 = await mk("swarm-20240102-100000-bb22", 30);
		await mk("swarm-20240103-100000-cc33", 1);
		const dry = await pruneSwarmRuns(root, { olderThanDays: 7, keepLastN: 1, dryRun: true });
		expect(dry.deleted).toContain("swarm-20240101-100000-aa11");
		// Dry-run deletes nothing on disk.
		expect(fs.existsSync(old1.swarmDir)).toBe(true);
		const applied = await pruneSwarmRuns(root, {
			olderThanDays: 7,
			keepLastN: 1,
			dryRun: false,
			excludeRunId: "swarm-20240102-100000-bb22",
		});
		expect(applied.deleted).not.toContain("swarm-20240102-100000-bb22");
		expect(fs.existsSync(old2.swarmDir)).toBe(true);
		expect(fs.existsSync(old1.swarmDir)).toBe(false);
		const runs = await listSwarmRuns(root);
		expect(runs[0].mtimeMs).toBeGreaterThanOrEqual(runs[runs.length - 1].mtimeMs);
		await fs.promises.rm(root, { recursive: true, force: true });
	});
});
