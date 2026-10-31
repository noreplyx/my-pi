import { describe, expect, test } from "bun:test";
import { splitShellCommands } from "./shell-split.ts";

describe("splitShellCommands", () => {
	test("single command stays whole", () => {
		expect(splitShellCommands("git status")).toEqual(["git status"]);
		expect(splitShellCommands("  git status --short  ")).toEqual(["git status --short"]);
	});
	test("splits on ; && || | & and newlines", () => {
		expect(splitShellCommands("a; b")).toEqual(["a", "b"]);
		expect(splitShellCommands("a && b")).toEqual(["a", "b"]);
		expect(splitShellCommands("a || b")).toEqual(["a", "b"]);
		expect(splitShellCommands("a | b")).toEqual(["a", "b"]);
		expect(splitShellCommands("a |& b")).toEqual(["a", "b"]);
		expect(splitShellCommands("a & b")).toEqual(["a", "b"]);
		expect(splitShellCommands("a\nb")).toEqual(["a", "b"]);
		expect(splitShellCommands("a\r\nb")).toEqual(["a", "b"]);
	});
	test("multi-segment chain", () => {
		expect(splitShellCommands("git status && git diff | head")).toEqual(["git status", "git diff", "head"]);
	});
	test("quoted delimiters do not split", () => {
		expect(splitShellCommands(`echo "a; b" && git status`)).toEqual([`echo "a; b"`, "git status"]);
		expect(splitShellCommands(`echo 'a && b' | head`)).toEqual([`echo 'a && b'`, "head"]);
		// Backticks are command substitution, not quoting — delimiters inside
		// them DO split so each substituted command is evaluated per-segment.
		expect(splitShellCommands("echo `a | b` && c")).toEqual(["echo `a", "b`", "c"]);
	});
	test("backslash escapes delimiter", () => {
		expect(splitShellCommands(`echo a\\;b && c`)).toEqual([`echo a\\;b`, "c"]);
	});
	test("redirects stay inside their segment", () => {
		expect(splitShellCommands("ls 2>&1 | head")).toEqual(["ls 2>&1", "head"]);
		expect(splitShellCommands("echo hi > /tmp/x; cat /tmp/x")).toEqual(["echo hi > /tmp/x", "cat /tmp/x"]);
	});
	test("drops empties, trims", () => {
		expect(splitShellCommands("a ;; b && ")).toEqual(["a", "b"]);
		expect(splitShellCommands("")).toEqual([]);
		expect(splitShellCommands("   ")).toEqual([]);
	});
});
