import { describe, expect, test } from "bun:test";
import { extractAuto, mergeAuto } from "./settings.ts";

describe("background settings", () => {
	test("top-level backgroundAuto wins", () => {
		expect(extractAuto({ backgroundAuto: true })).toBe(true);
		expect(extractAuto({ backgroundAuto: false })).toBe(false);
	});

	test("background.enabled alias", () => {
		expect(extractAuto({ background: { enabled: true } })).toBe(true);
		expect(extractAuto({ background: { enabled: false } })).toBe(false);
	});

	test("invalid/missing → undefined", () => {
		expect(extractAuto({})).toBeUndefined();
		expect(extractAuto(null)).toBeUndefined();
		expect(extractAuto({ backgroundAuto: "yes" })).toBeUndefined();
	});

	test("project overrides user, default false", () => {
		expect(mergeAuto({ backgroundAuto: true }, { backgroundAuto: false })).toBe(false);
		expect(mergeAuto({ backgroundAuto: true }, {})).toBe(true);
		expect(mergeAuto({}, {})).toBe(false);
	});
});
