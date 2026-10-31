import { describe, expect, test } from "bun:test";
import {
	globToRegExp,
	hasInvalidGlob,
	hasInvalidGlobMatch,
	hasInvalidRegex,
	isRegexPattern,
	matchOne,
	matchTargets,
	matchToolName,
} from "./matcher.ts";

describe("isRegexPattern", () => {
	test("re: prefix is always regex", () => {
		expect(isRegexPattern("re:^git")).toEqual({ body: "^git", flags: "" });
	});
	test("slash with flags is regex", () => {
		expect(isRegexPattern("/^rm\\s+-rf/i")).toEqual({ body: "^rm\\s+-rf", flags: "i" });
	});
	test("caret body without flags is regex", () => {
		expect(isRegexPattern("/^foo/")).not.toBeNull();
	});
	test("trailing-slash path is NOT regex", () => {
		expect(isRegexPattern("/foo/bar/")).toBeNull();
		expect(isRegexPattern("/tmp/x/")).toBeNull();
	});
	test("absolute glob path is NOT regex", () => {
		expect(isRegexPattern("/tmp/scratch/**")).toBeNull();
	});
	test("non-slash patterns are not slash-regex", () => {
		expect(isRegexPattern("re:")).toEqual({ body: "", flags: "" });
		expect(isRegexPattern("npm publish")).toBeNull();
	});
});

describe("glob pathMode", () => {
	test("single * crosses / in command mode only", () => {
		expect(globToRegExp("src/*").test("src/a")).toBe(true);
		expect(globToRegExp("src/*", false).test("src/a/b")).toBe(true);
		expect(globToRegExp("src/*", true).test("src/a/b")).toBe(false);
	});
	test("? stays within segment in path mode", () => {
		expect(globToRegExp("src/?", true).test("src/a")).toBe(true);
		expect(globToRegExp("src/?", true).test("src/ab")).toBe(false);
		expect(globToRegExp("src/?", true).test("src//")).toBe(false);
	});
	test("** still crosses segments in path mode", () => {
		expect(globToRegExp("src/**", true).test("src/a/b")).toBe(true);
		expect(globToRegExp("**/.env*", true).test("/repo/sub/.env.local")).toBe(true);
	});
	test("command glob still matches across /", () => {
		expect(matchOne("*rm -rf*", "echo x; rm -rf /tmp/y")).toBe(true);
	});
	test("matchTargets threads pathMode", () => {
		expect(matchTargets("src/*", ["src/a"], true)).toBe(true);
		expect(matchTargets("src/*", ["src/a/b"], true)).toBe(false);
		expect(matchTargets("src/*", ["src/a/b"], false)).toBe(true);
	});
});

describe("hasInvalidRegex", () => {
	test("detects uncompilable patterns", () => {
		expect(hasInvalidRegex("re:([" )).toBe(true);
		expect(hasInvalidRegex("re:^git")).toBe(false);
		expect(hasInvalidRegex("*foo*")).toBe(false);
		expect(hasInvalidRegex(["*a*", "re:(["])).toBe(true);
		expect(hasInvalidRegex(undefined)).toBe(false);
	});
});

describe("matchToolName", () => {
	test("exact and glob tool matching unaffected by pathMode", () => {
		expect(matchToolName("bash", "bash")).toBe(true);
		expect(matchToolName("mcp__*", "mcp__github")).toBe(true);
		expect(matchToolName("bash", "read")).toBe(false);
	});
	test("exact matching is case-insensitive", () => {
		expect(matchToolName("Read", "read")).toBe(true);
		expect(matchToolName("BASH", "bash")).toBe(true);
		expect(matchToolName("MCP__*", "mcp__github")).toBe(true);
	});
});

describe("hasInvalidGlob", () => {
	test("detects unclosed bracket and trailing backslash", () => {
		expect(hasInvalidGlob("src/[abc")).toBe(true);
		expect(hasInvalidGlob("src/*.ts\\")).toBe(true);
		expect(hasInvalidGlob("src/*.ts")).toBe(false);
	});
	test("detects character classes whose translation never compiles", () => {
		expect(hasInvalidGlob("[z-a]")).toBe(true);
		// Invalid globs never match via matchOne (fail-closed in loader firstMatch).
		expect(matchOne("[z-a]", "a")).toBe(false);
	});
	test("non-globs and regexes are never invalid globs", () => {
		expect(hasInvalidGlob("npm publish")).toBe(false);
		expect(hasInvalidGlob("re:([")).toBe(false);
		expect(hasInvalidGlobMatch(undefined)).toBe(false);
	});
});
