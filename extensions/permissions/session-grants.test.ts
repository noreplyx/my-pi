import { describe, expect, test } from "bun:test";
import { createSessionGrants, grantKey, SESSION_CHOICES } from "./session-grants.ts";

describe("session grants", () => {
	test("offers Allow once / Allow for this session / Deny", () => {
		expect([...SESSION_CHOICES]).toEqual(["Allow once", "Allow for this session", "Deny"]);
	});

	test("key is exact tool + target", () => {
		expect(grantKey("bash", "npm test")).not.toBe(grantKey("bash", "rm -rf /"));
		expect(grantKey("bash", "npm test")).toBe(grantKey("bash", "npm test"));
		expect(grantKey("write", "a.txt")).not.toBe(grantKey("read", "a.txt"));
	});

	test("add/has/clear round-trip", () => {
		const g = createSessionGrants();
		expect(g.has("bash", "npm test")).toBeUndefined();
		g.add("bash", "npm test", "global rule #1");
		expect(g.has("bash", "npm test")?.tool).toBe("bash");
		// different target still misses
		expect(g.has("bash", "npm run build")).toBeUndefined();
		expect(g.size).toBe(1);
		expect(g.clear()).toBe(1);
		expect(g.size).toBe(0);
		expect(g.has("bash", "npm test")).toBeUndefined();
	});
});

describe("directory grants", () => {
	test("covers sibling, nested, and the dir itself — never the parent", () => {
		const g = createSessionGrants();
		g.addDirectory("write", "/a/b", "global rule #1");
		expect(g.hasDirectory("write", "/a/b/f1.txt")?.scope).toBe("directory");
		expect(g.hasDirectory("write", "/a/b/sub/f2.txt")).toBeDefined();
		expect(g.hasDirectory("write", "/a/b")).toBeDefined();
		expect(g.hasDirectory("write", "/a/other.txt")).toBeUndefined();
		expect(g.hasDirectory("write", "/a")).toBeUndefined();
		expect(g.hasDirectory("read", "/a/b/f1.txt")).toBeUndefined();
	});

	test("child grant does not cover parent-dir calls", () => {
		const g = createSessionGrants();
		g.addDirectory("write", "/a/b/sub", "x");
		expect(g.hasDirectory("write", "/a/b/f.txt")).toBeUndefined();
		expect(g.hasDirectory("write", "/a/b/sub/f.txt")).toBeDefined();
	});

	test("normalizes trailing slashes, counts both kinds on clear", () => {
		const g = createSessionGrants();
		g.add("bash", "rm -rf /", "x");
		g.addDirectory("read", "/a/b/", "x");
		expect(g.hasDirectory("read", "/a/b/f")).toBeDefined();
		expect(g.list().find((x) => x.scope === "directory")?.target).toBe("/a/b");
		expect(g.size).toBe(2);
		expect(g.clear()).toBe(2);
		expect(g.size).toBe(0);
	});
});
