import { describe, expect, test } from "bun:test";
import {
	createForwardedPermissionStore,
	FORWARDED_SESSION_CHOICES,
	isPermissionConfirm,
	isPermissionSelect,
	normalizeAgentSegment,
	normalizePermissionKey,
} from "./forwarded-permissions.ts";

describe("forwarded permission detection", () => {
	test("permission select shape is detected", () => {
		expect(isPermissionSelect({ method: "select", title: "Allow bash npm test?", options: [...FORWARDED_SESSION_CHOICES] })).toBe(true);
	});

	test("ask_user select is not a permission dialog", () => {
		expect(isPermissionSelect({ method: "select", title: "Pick one?", options: ["a", "b"] })).toBe(false);
		// Same title but wrong options must not match.
		expect(isPermissionSelect({ method: "select", title: "Allow bash x?", options: ["yes", "no"] })).toBe(false);
		// Same options but non-permission title must not match.
		expect(isPermissionSelect({ method: "select", title: "Pick one?", options: [...FORWARDED_SESSION_CHOICES] })).toBe(false);
		// Option order matters (exact match guards against mimicry).
		expect(isPermissionSelect({ method: "select", title: "Allow bash x?", options: [...FORWARDED_SESSION_CHOICES].reverse() })).toBe(false);
	});

	test("unsupported methods are not permission dialogs", () => {
		expect(isPermissionSelect({ method: "editor", title: "Allow bash x?", options: [...FORWARDED_SESSION_CHOICES] })).toBe(false);
		expect(isPermissionSelect({ method: "input", title: "Allow bash x?", options: [...FORWARDED_SESSION_CHOICES] })).toBe(false);
	});

	test("permission confirm fallback is detected separately", () => {
		expect(isPermissionConfirm({ method: "confirm", title: "Allow bash x?" })).toBe(true);
		expect(isPermissionSelect({ method: "confirm", title: "Allow bash x?" })).toBe(false);
		expect(isPermissionConfirm({ method: "confirm", title: "Proceed?" })).toBe(false);
	});
});

describe("normalizeAgentSegment", () => {
	test("lowercases and trims (agent lookup is case-insensitive)", () => {
		expect(normalizeAgentSegment("Reviewer")).toBe("reviewer");
		expect(normalizeAgentSegment("  coder  ")).toBe("coder");
		expect(normalizeAgentSegment("GENERAL")).toBe(normalizeAgentSegment("general"));
	});
});

describe("normalizePermissionKey", () => {
	test("collapses whitespace and trims, raw title passes through", () => {
		expect(normalizePermissionKey("  Allow   bash   x?  ")).toBe("Allow bash x?");
		expect(normalizePermissionKey("[reviewer] Allow bash x?")).toBe("[reviewer] Allow bash x?");
	});

	test("preserves case", () => {
		expect(normalizePermissionKey("Allow bash FOO?")).not.toBe(normalizePermissionKey("Allow bash foo?"));
	});
});

describe("forwarded permission store", () => {
	test("session grants hit, everything else misses", () => {
		const store = createForwardedPermissionStore();
		expect(store.get("Allow bash x?")).toBeUndefined();
		store.setSession("Allow bash x?");
		expect(store.get("Allow bash x?")).toBe("session");
		expect(store.size).toBe(1);
	});

	test("empty keys are ignored", () => {
		const store = createForwardedPermissionStore();
		store.setSession("");
		expect(store.size).toBe(0);
	});

	test("FIFO cap evicts oldest", () => {
		const store = createForwardedPermissionStore(2);
		store.setSession("a");
		store.setSession("b");
		store.setSession("c");
		expect(store.size).toBe(2);
		expect(store.get("a")).toBeUndefined();
		expect(store.get("b")).toBe("session");
		expect(store.get("c")).toBe("session");
	});

	test("clear returns count", () => {
		const store = createForwardedPermissionStore();
		store.setSession("a");
		store.setSession("b");
		expect(store.clear()).toBe(2);
		expect(store.size).toBe(0);
	});
});
