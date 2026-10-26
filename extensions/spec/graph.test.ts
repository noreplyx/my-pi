import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extractWikilinks, listSpecs, rebuildIndex, specPath, ensureSpecsDir } from "./graph.ts";

let dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "spec-graph-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
	dirs = [];
});

describe("graph", () => {
	test("extractWikilinks dedupes and slugifies", () => {
		expect(extractWikilinks("- [[Auth Spec]]\n- [[auth-spec]]\n- [[Other#head|Alias]]")).toEqual([
			"auth-spec",
			"other",
		]);
	});

	test("rebuildIndex creates MOC hub with links", () => {
		const cwd = tmp();
		ensureSpecsDir(cwd);
		fs.writeFileSync(specPath(cwd, "auth"), "---\ntitle: Auth\nstatus: draft\nkind: http\nupdated: 2026-10-26\n---\n\n# Auth\n\nSee [[billing]].\n");
		fs.writeFileSync(specPath(cwd, "billing"), "# Billing\n");
		const idx = rebuildIndex(cwd);
		const md = fs.readFileSync(idx, "utf8");
		expect(md).toMatch(/\[\[auth\]\]/);
		expect(md).toMatch(/\[\[billing\]\]/);
		expect(md).toMatch(/\| Spec \| Title \|/);
		const specs = listSpecs(cwd);
		expect(specs.map((s) => s.slug)).toEqual(["auth", "billing"]);
	});

	test("rebuildIndex is idempotent and preserves intro", () => {
		const cwd = tmp();
		ensureSpecsDir(cwd);
		fs.writeFileSync(specPath(cwd, "a"), "# A\n");
		rebuildIndex(cwd);
		const idx = path.join(cwd, "specs", "index.md");
		fs.writeFileSync(idx, "# My Vault\n\nintro here\n\n" + fs.readFileSync(idx, "utf8").slice(fs.readFileSync(idx, "utf8").indexOf("<!--")));
		rebuildIndex(cwd);
		const md = fs.readFileSync(idx, "utf8");
		expect(md).toMatch(/# My Vault/);
		expect((md.match(/## Specs \(1\)/g) ?? []).length).toBe(1);
	});
});
