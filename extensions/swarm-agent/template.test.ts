import { describe, expect, test } from "bun:test";
import {
	MAX_ITEM_CHARS,
	MAX_SWARM_ITEMS,
	MAX_TEMPLATE_CHARS,
	buildSwarmTasks,
	expandTemplate,
	hasItemPlaceholder,
	validateSwarmInput,
} from "./template.ts";

describe("hasItemPlaceholder", () => {
	test("detects {item}", () => {
		expect(hasItemPlaceholder("Review {item}")).toBe(true);
		expect(hasItemPlaceholder("Review {index}/{count}")).toBe(false);
		expect(hasItemPlaceholder("no placeholders")).toBe(false);
	});
});

describe("expandTemplate", () => {
	test("replaces item/index/count", () => {
		expect(expandTemplate("Review {item} ({index}/{count})", "src/a.ts", 1, 2)).toBe(
			"Review src/a.ts (1/2)",
		);
	});

	test("replaces all {item} occurrences", () => {
		expect(expandTemplate("{item} + {item}", "x", 1, 1)).toBe("x + x");
	});

	test("passes $-patterns through literally", () => {
		expect(expandTemplate("cost of {item}", "$& and $' plus $$ and $1", 1, 1)).toBe(
			"cost of $& and $' plus $$ and $1",
		);
	});

	test("leaves unknown placeholders untouched", () => {
		expect(expandTemplate("a {previous} {item}", "x", 1, 1)).toBe("a {previous} x");
	});
});

describe("buildSwarmTasks", () => {
	test("order-preserving expansion with 1-based index", () => {
		expect(buildSwarmTasks("Do {item} ({index}/{count})", ["a", "b"])).toEqual([
			"Do a (1/2)",
			"Do b (2/2)",
		]);
	});
});

describe("validateSwarmInput", () => {
	test("accepts a minimal valid input", () => {
		const r = validateSwarmInput("Review {item}", ["a.ts", "b.ts"]);
		expect(r.ok).toBe(true);
	});

	test("rejects empty template and missing {item}", () => {
		expect(validateSwarmInput("", ["a"]).ok).toBe(false);
		expect(validateSwarmInput("no placeholder", ["a"]).ok).toBe(false);
		expect(validateSwarmInput(42, ["a"]).ok).toBe(false);
	});

	test("rejects empty / non-array / oversized items", () => {
		expect(validateSwarmInput("Do {item}", []).ok).toBe(false);
		expect(validateSwarmInput("Do {item}", "nope").ok).toBe(false);
		expect(validateSwarmInput("Do {item}", ["ok", ""]).ok).toBe(false);
		expect(validateSwarmInput("Do {item}", new Array(MAX_SWARM_ITEMS + 1).fill("x")).ok).toBe(
			false,
		);
	});

	test("rejects oversized template and item", () => {
		expect(validateSwarmInput(`Do {item} ${"t".repeat(MAX_TEMPLATE_CHARS)}`, ["x"]).ok).toBe(
			false,
		);
		expect(validateSwarmInput("Do {item}", ["x".repeat(MAX_ITEM_CHARS + 1)]).ok).toBe(false);
	});

	test("rejects flag-like items", () => {
		const r = validateSwarmInput("Do {item}", ["--help"]);
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.error).toContain("flag");
	});
});
