import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AUTO_APPROVE_ENV, clearAutoApprove, isAutoApproveEnabled, isAutoApproveEnvSet, parseAutoApproveArg, setAutoApprove } from "./state.ts";

let savedEnv: string | undefined;

beforeEach(() => {
	savedEnv = process.env[AUTO_APPROVE_ENV];
	delete process.env[AUTO_APPROVE_ENV];
});

afterEach(() => {
	if (savedEnv === undefined) delete process.env[AUTO_APPROVE_ENV];
	else process.env[AUTO_APPROVE_ENV] = savedEnv;
});

describe("auto-approve state", () => {
	test("defaults OFF", () => {
		expect(isAutoApproveEnabled()).toBe(false);
	});

	test("set on/off round-trips through process.env", () => {
		expect(setAutoApprove(true)).toBe(true);
		expect(process.env[AUTO_APPROVE_ENV]).toBe("1");
		expect(isAutoApproveEnabled()).toBe(true);
		expect(setAutoApprove(false)).toBe(false);
		expect(process.env[AUTO_APPROVE_ENV]).toBeUndefined();
		expect(isAutoApproveEnabled()).toBe(false);
	});

	test("clear resets to OFF and reports count", () => {
		expect(clearAutoApprove()).toBe(0);
		setAutoApprove(true);
		expect(clearAutoApprove()).toBe(1);
		expect(isAutoApproveEnabled()).toBe(false);
	});

	test("reads live env, not a module snapshot (cross-extension sharing)", () => {
		// Regression: with a module-level `let enabled`, each extension file
		// loads its own instance (jiti moduleCache:false), so a toggle set
		// elsewhere is invisible. The env store must reflect external writes.
		process.env[AUTO_APPROVE_ENV] = "1";
		expect(isAutoApproveEnabled()).toBe(true);
		delete process.env[AUTO_APPROVE_ENV];
		expect(isAutoApproveEnabled()).toBe(false);
	});
});

describe("isAutoApproveEnvSet", () => {
	test("only exact '1' counts", () => {
		expect(isAutoApproveEnvSet({ [AUTO_APPROVE_ENV]: "1" } as NodeJS.ProcessEnv)).toBe(true);
		expect(isAutoApproveEnvSet({} as NodeJS.ProcessEnv)).toBe(false);
		expect(isAutoApproveEnvSet({ [AUTO_APPROVE_ENV]: "0" } as NodeJS.ProcessEnv)).toBe(false);
		expect(isAutoApproveEnvSet({ [AUTO_APPROVE_ENV]: "true" } as NodeJS.ProcessEnv)).toBe(false);
		expect(isAutoApproveEnvSet({ [AUTO_APPROVE_ENV]: "" } as NodeJS.ProcessEnv)).toBe(false);
	});

	test("defaults to provided process env", () => {
		delete process.env[AUTO_APPROVE_ENV];
		expect(isAutoApproveEnvSet()).toBe(false);
		process.env[AUTO_APPROVE_ENV] = "1";
		expect(isAutoApproveEnvSet()).toBe(true);
	});
});

describe("parseAutoApproveArg", () => {
	test("empty means status", () => {
		expect(parseAutoApproveArg("")).toBe("status");
		expect(parseAutoApproveArg(undefined)).toBe("status");
		expect(parseAutoApproveArg("   ")).toBe("status");
	});

	test("on aliases", () => {
		for (const a of ["on", "ON", " enable ", "enabled", "1", "true"]) {
			expect(parseAutoApproveArg(a)).toBe("on");
		}
	});

	test("off aliases", () => {
		for (const a of ["off", "OFF", " disable ", "disabled", "0", "false"]) {
			expect(parseAutoApproveArg(a)).toBe("off");
		}
	});

	test("status aliases", () => {
		for (const a of ["status", "state", "show"]) {
			expect(parseAutoApproveArg(a)).toBe("status");
		}
	});

	test("garbage is invalid", () => {
		expect(parseAutoApproveArg("yes")).toBe("invalid");
		expect(parseAutoApproveArg("on Please")).toBe("invalid");
	});
});
