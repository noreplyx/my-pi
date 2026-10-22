import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateWorkers } from "./swarm-orchestrator.ts";
import { appendOutboxValidated, createSwarmRun, forkSwarmRun, isCancelled, readManifest, requestCancel, swarmRunDir, updateManifestStatus, writeManifest } from "./swarm.ts";
import { buildMergerInput, isValidRunId } from "./utils.ts";

async function mkRoot(): Promise<string> {
	return await fs.promises.mkdtemp(path.join(os.tmpdir(), "swarm-ext-"));
}

describe("validateWorkers", () => {
	test("accepts valid workers", () => {
		expect(validateWorkers([{ id: "a-1", agent: "coder", task: "x" }])).toBeNull();
	});
	test("rejects too many, bad ids, dupes", () => {
		expect(validateWorkers(Array.from({ length: 9 }, (_, i) => ({ id: `w${i}`, agent: "coder", task: "x" })))).toContain("Max");
		expect(validateWorkers([{ id: "Bad Name", agent: "coder", task: "x" }])).toContain("Invalid worker id");
		expect(validateWorkers([
			{ id: "a", agent: "coder", task: "x" },
			{ id: "a", agent: "reviewer", task: "y" },
		])).toContain("Duplicate");
	});
});

describe("manifest + cancel + fork", () => {
	test("write/read/update round-trips", async () => {
		const root = await mkRoot();
		const run = await createSwarmRun(root, "swarm-20240101-120000-ab12");
		await writeManifest(run.swarmDir, { runId: run.runId, goal: "g", workers: [{ id: "a", agent: "coder" }], status: "running", createdAt: new Date().toISOString() });
		expect((await readManifest(run.swarmDir))?.goal).toBe("g");
		await updateManifestStatus(run.swarmDir, "done");
		expect((await readManifest(run.swarmDir))?.status).toBe("done");
		await fs.promises.rm(root, { recursive: true, force: true });
	});

	test("cancel flag flips", async () => {
		const root = await mkRoot();
		const run = await createSwarmRun(root, "swarm-20240101-120001-ab12");
		expect(await isCancelled(run.swarmDir)).toBe(false);
		await requestCancel(run.swarmDir, "test");
		expect(await isCancelled(run.swarmDir)).toBe(true);
		await fs.promises.rm(root, { recursive: true, force: true });
	});

	test("fork creates <runId>-rN with parent link, keeps parent intact", async () => {
		const root = await mkRoot();
		const run = await createSwarmRun(root, "swarm-20240101-120002-ab12");
		await writeManifest(run.swarmDir, { runId: run.runId, goal: "goal-1", workers: [{ id: "a", agent: "coder" }], status: "done", createdAt: new Date().toISOString() });
		const forked = await forkSwarmRun(root, run.runId);
		if ("error" in forked) throw new Error(forked.error);
		expect(isValidRunId(forked.runId)).toBe(true);
		expect(forked.runId).toBe(`${run.runId}-r2`);
		expect((await readManifest(forked.swarmDir))?.parentRunId).toBe(run.runId);
		expect((await readManifest(forked.swarmDir))?.goal).toBe("goal-1");
		expect((await readManifest(run.swarmDir))?.status).toBe("done");
		expect(swarmRunDir(root, forked.runId)).toBe(forked.swarmDir);
		await fs.promises.rm(root, { recursive: true, force: true });
	});

	test("validated outbox rejects empty, caps body", async () => {
		const root = await mkRoot();
		const run = await createSwarmRun(root, "swarm-20240101-120003-ab12");
		expect((await appendOutboxValidated(run.swarmDir, { from: "", body: "x" })).ok).toBe(false);
		expect((await appendOutboxValidated(run.swarmDir, { from: "a", body: "  " })).ok).toBe(false);
		const big = "z".repeat(20000);
		const ok = await appendOutboxValidated(run.swarmDir, { from: "a", body: big }, 1000);
		expect(ok.ok).toBe(true);
		const raw = await fs.promises.readFile(path.join(run.swarmDir, "outbox.jsonl"), "utf-8");
		expect(Buffer.byteLength(JSON.parse(raw.trim()).body, "utf8")).toBeLessThanOrEqual(1000);
		await fs.promises.rm(root, { recursive: true, force: true });
	});
});

describe("buildMergerInput", () => {
	test("packs within budget, deterministic order, counts omitted", () => {
		const out = buildMergerInput(
			[
				{ id: "b", agent: "coder", body: "B".repeat(5000) },
				{ id: "a", agent: "reviewer", body: "A" },
			],
			2000,
		);
		expect(out.text.indexOf("#### a")).toBeLessThan(out.text.indexOf("#### b") >= 0 ? out.text.indexOf("#### b") : Infinity);
		expect(out.included + out.omitted).toBe(2);
		expect(Buffer.byteLength(out.text, "utf8")).toBeLessThanOrEqual(3000);
	});
	test("empty sections yield placeholder", () => {
		expect(buildMergerInput([]).text).toContain("no worker outputs");
	});
});
