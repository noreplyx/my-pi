/** Tests for model-memory persistence (mocked ExtensionAPI + temp dirs). */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import factory from "./index.ts";
import {
	persistModelAsDefault,
	resolveAgentDir,
	settingsPathFor,
	shouldPersistSource,
} from "./persist.ts";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "model-memory-"));
}

function makePi() {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const pi: any = {
		on: (event: string, handler: any) => {
			handlers.set(event, handler);
			return () => {};
		},
	};
	return { pi, handlers };
}

function makeCtx() {
	const notices: { message: string; type?: string }[] = [];
	const ctx: any = {
		ui: {
			notify: (message: string, type?: string) => {
				notices.push({ message, type });
			},
		},
	};
	return { ctx, notices };
}

describe("model-memory persist helpers", () => {
	test("shouldPersistSource ignores restore only", () => {
		expect(shouldPersistSource("set")).toBe(true);
		expect(shouldPersistSource("cycle")).toBe(true);
		expect(shouldPersistSource("restore")).toBe(false);
		expect(shouldPersistSource(undefined)).toBe(true);
	});

	test("creates settings.json when missing, preserving no other keys", () => {
		const dir = makeTempDir();
		const result = persistModelAsDefault(dir, "opencode-go", "kimi-k3");
		expect(result.ok).toBe(true);
		const parsed = JSON.parse(fs.readFileSync(settingsPathFor(dir), "utf-8"));
		expect(parsed.defaultProvider).toBe("opencode-go");
		expect(parsed.defaultModel).toBe("kimi-k3");
	});

	test("updates provider/model while preserving other keys", () => {
		const dir = makeTempDir();
		fs.writeFileSync(
			settingsPathFor(dir),
			JSON.stringify(
				{ lastChangelogVersion: "1.4.0", defaultProvider: "a", defaultModel: "b", theme: "x" },
				null,
				2,
			),
		);
		const result = persistModelAsDefault(dir, "opencode-go", "muse-spark-1.3-contributor");
		expect(result.ok).toBe(true);
		const parsed = JSON.parse(fs.readFileSync(settingsPathFor(dir), "utf-8"));
		expect(parsed.defaultProvider).toBe("opencode-go");
		expect(parsed.defaultModel).toBe("muse-spark-1.3-contributor");
		expect(parsed.lastChangelogVersion).toBe("1.4.0");
		expect(parsed.theme).toBe("x");
	});

	test("no-op when already current", () => {
		const dir = makeTempDir();
		fs.writeFileSync(
			settingsPathFor(dir),
			JSON.stringify({ defaultProvider: "p", defaultModel: "m" }),
		);
		const result = persistModelAsDefault(dir, "p", "m");
		expect(result.ok).toBe(true);
		expect(result.skipped).toBe("already current");
	});

	test("corrupt JSON fails closed without overwriting", () => {
		const dir = makeTempDir();
		const before = "{ not json";
		fs.writeFileSync(settingsPathFor(dir), before);
		const result = persistModelAsDefault(dir, "p", "m");
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/valid JSON/);
		expect(fs.readFileSync(settingsPathFor(dir), "utf-8")).toBe(before);
	});

	test("rejects empty provider/id", () => {
		const dir = makeTempDir();
		expect(persistModelAsDefault(dir, "", "m").ok).toBe(false);
		expect(persistModelAsDefault(dir, "p", "").ok).toBe(false);
	});

	test("resolveAgentDir honors override env", () => {
		expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "/tmp/custom" } as any)).toBe("/tmp/custom");
		expect(resolveAgentDir({} as any)).toBe(path.join(os.homedir(), ".pi", "agent"));
	});
});

describe("model-memory extension", () => {
	test("persists on set, ignores restore", async () => {
		const dir = makeTempDir();
		const saved = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			const { pi, handlers } = makePi();
			(factory as any)(pi);
			const { ctx, notices } = makeCtx();
			const handler = handlers.get("model_select");
			expect(handler).toBeDefined();

			await handler(
				{ type: "model_select", model: { provider: "opencode-go", id: "kimi-k3" }, source: "set" },
				ctx,
			);
			expect(JSON.parse(fs.readFileSync(settingsPathFor(dir), "utf-8")).defaultModel).toBe("kimi-k3");

			await handler(
				{ type: "model_select", model: { provider: "p", id: "other" }, source: "restore" },
				ctx,
			);
			expect(JSON.parse(fs.readFileSync(settingsPathFor(dir), "utf-8")).defaultModel).toBe("kimi-k3");
			expect(notices.length).toBe(0);
		} finally {
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved;
		}
	});
});
