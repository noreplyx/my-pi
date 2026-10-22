import { describe, expect, test } from "bun:test";
import { decideQuestionResponse, isFireAndForgetMethod, isForwardedMethod, withQuestionLock } from "./questions.ts";

describe("questions bridge", () => {
	test("fire-and-forget methods need no response", () => {
		for (const m of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]) {
			expect(isFireAndForgetMethod(m)).toBe(true);
			const r = decideQuestionResponse({ id: "1", method: m }, { hasUI: true, allowQuestions: true });
			expect(r.response).toBeNull();
		}
	});

	test("forwarded methods are select/confirm/input only", () => {
		expect(isForwardedMethod("select")).toBe(true);
		expect(isForwardedMethod("confirm")).toBe(true);
		expect(isForwardedMethod("input")).toBe(true);
		expect(isForwardedMethod("editor")).toBe(false);
		expect(isForwardedMethod("custom")).toBe(false);
	});

	test("unsupported methods get cancelled + note", () => {
		const r = decideQuestionResponse({ id: "abc", method: "editor", title: "Edit me" }, { hasUI: true, allowQuestions: true });
		expect(r.response).toEqual({ type: "extension_ui_response", id: "abc", cancelled: true });
		expect(r.note).toContain("unsupported");
	});

	test("no-UI auto-dismisses with reason", () => {
		const sel = decideQuestionResponse({ id: "1", method: "select", title: "Pick" }, { hasUI: false, allowQuestions: true });
		expect(sel.response).toEqual({ type: "extension_ui_response", id: "1", cancelled: true });
		expect(sel.note).toContain("no UI");
		const conf = decideQuestionResponse({ id: "2", method: "confirm", title: "Proceed?" }, { hasUI: false, allowQuestions: true });
		expect(conf.response).toEqual({ type: "extension_ui_response", id: "2", confirmed: false });
	});

	test("allowQuestions:false auto-dismisses", () => {
		const r = decideQuestionResponse({ id: "1", method: "input", title: "Name?" }, { hasUI: true, allowQuestions: false });
		expect(r.response).toEqual({ type: "extension_ui_response", id: "1", cancelled: true });
		expect(r.note).toContain("disabled");
	});

	test("mutex serializes concurrent questions", async () => {
		const order: number[] = [];
		const slow = withQuestionLock(async () => {
			await new Promise((r) => setTimeout(r, 30));
			order.push(1);
			return 1;
		});
		const fast = withQuestionLock(async () => {
			order.push(2);
			return 2;
		});
		const [a, b] = await Promise.all([slow, fast]);
		expect(a).toBe(1);
		expect(b).toBe(2);
		expect(order).toEqual([1, 2]);
	});
});
