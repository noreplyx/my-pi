/**
 * Obsidian graph support: [[wikilinks]] + specs/index.md MOC.
 *
 * `specs/` IS the vault folder (open it directly in Obsidian).
 * Every create/edit/delete rebuilds the MOC so Graph View always shows
 * a hub (index.md) + peer edges ([[wikilinks]] in Related sections).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { slugify, type SpecKind } from "./template.ts";
import { validateSpecMarkdown } from "./validate.ts";

export const SPECS_DIR = "specs";
export const INDEX_FILE = "index.md";
export const ARCHIVE_DIR = "_archived";
const MOC_MARKER = "<!-- spec-index:auto -->";

export const MAX_SPEC_FILES = 1000;
export const MAX_SPEC_FILE_BYTES = 1024 * 1024;
export const MAX_TITLE_CHARS = 200;
export const MAX_UPDATED_CHARS = 50;

const VALID_STATUSES = new Set(["draft", "confirmed", "implemented"]);
const VALID_KINDS = new Set(["http", "non-http", "mixed"]);

export function specsDir(cwd: string): string {
	return path.join(cwd, SPECS_DIR);
}

export function specPath(cwd: string, slug: string): string {
	return path.join(specsDir(cwd), `${slugify(slug)}.md`);
}

export function ensureSpecsDir(cwd: string): string {
	const dir = specsDir(cwd);
	fs.mkdirSync(dir, { recursive: true });
	fs.mkdirSync(path.join(dir, ARCHIVE_DIR), { recursive: true });
	return dir;
}

export function extractWikilinks(md: string): string[] {
	const out = new Set<string>();
	for (const m of md.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
		const s = slugify(m[1]);
		if (s) out.add(s);
	}
	return [...out].sort();
}

export interface SpecEntry {
	slug: string;
	title: string;
	status: string;
	kind: string;
	updated: string;
	validity: "valid" | "invalid";
	missing?: string[];
}

function parseFrontmatter(md: string): Record<string, string> {
	const m = /^---\s*\n([\s\S]*?)\n---/.exec(md);
	const out: Record<string, string> = {};
	if (!m) return out;
	for (const line of m[1].split("\n")) {
		const i = line.indexOf(":");
		if (i === -1) continue;
		out[line.slice(0, i).trim().toLowerCase()] = line
			.slice(i + 1)
			.trim()
			.replace(/^\[|\]$/g, "");
	}
	return out;
}

function titleOf(md: string, fallback: string): string {
	const fm = parseFrontmatter(md);
	if (fm.title) return fm.title;
	const m = /^#\s+(.+)$/m.exec(md);
	return m ? m[1].trim() : fallback;
}

function normalizeStatus(raw: unknown): string {
	const v = String(raw ?? "").trim().toLowerCase();
	return VALID_STATUSES.has(v) ? v : "draft";
}

function normalizeKind(raw: unknown): SpecKind {
	const v = String(raw ?? "").trim().toLowerCase();
	return (VALID_KINDS.has(v) ? v : "mixed") as SpecKind;
}

function sanitizeTitle(raw: string): string {
	return raw.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
}

function sanitizeUpdated(raw: string): string {
	return raw.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_UPDATED_CHARS);
}

/** Escape a value for embedding in the MOC markdown table. */
function escapeMocCell(value: string): string {
	return (value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\|/g, "\\|")
		.replace(/[\r\n]+/g, " ");
}

export function listSpecs(cwd: string): SpecEntry[] {
	const dir = specsDir(cwd);
	try {
		const dst = fs.lstatSync(dir);
		if (dst.isSymbolicLink()) return [];
		if (!dst.isDirectory()) return [];
	} catch {
		return [];
	}
	let files: string[];
	try {
		files = fs.readdirSync(dir);
	} catch {
		return [];
	}
	files.sort();
	if (files.length > MAX_SPEC_FILES) files = files.slice(0, MAX_SPEC_FILES);
	const entries: SpecEntry[] = [];
	for (const f of files) {
		if (f === INDEX_FILE || f === ARCHIVE_DIR) continue;
		if (!f.endsWith(".md")) continue;
		const slug = f.slice(0, -3);
		if (!slug) continue;
		const full = path.join(dir, slug + ".md");
		let st: fs.Stats;
		try {
			const lst = fs.lstatSync(full);
			if (lst.isSymbolicLink()) continue;
			if (!lst.isFile()) continue;
			st = lst;
		} catch {
			continue;
		}
		if (st.size > MAX_SPEC_FILE_BYTES) {
			entries.push({
				slug,
				title: sanitizeTitle(slug),
				status: "draft",
				kind: "mixed",
				updated: "",
				validity: "invalid",
				missing: [`oversize: file exceeds 1MB (${st.size} bytes, skipped)`],
			});
			continue;
		}
		let md: string;
		try {
			md = fs.readFileSync(full, "utf8");
		} catch {
			continue;
		}
		const fm = parseFrontmatter(md);
		const kind = normalizeKind(fm.kind);
		const v = validateSpecMarkdown(md, kind);
		entries.push({
			slug,
			title: sanitizeTitle(titleOf(md, slug)),
			status: normalizeStatus(fm.status),
			kind,
			updated: sanitizeUpdated(fm.updated || ""),
			validity: v.ok ? "valid" : "invalid",
			...(v.ok ? {} : { missing: v.missing }),
		});
	}
	return entries.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Rebuild specs/index.md MOC. Idempotent; preserves manual intro above marker. */
export function rebuildIndex(cwd: string): string {
	ensureSpecsDir(cwd);
	const indexPath = path.join(specsDir(cwd), INDEX_FILE);
	const specs = listSpecs(cwd);

	let intro = "# Specs — Map of Content\n\nOpen this folder as an Obsidian vault to see the spec graph.\n";
	if (fs.existsSync(indexPath)) {
		const cur = fs.readFileSync(indexPath, "utf8");
		const at = cur.indexOf(MOC_MARKER);
		if (at !== -1) {
			const head = cur.slice(0, at).trim();
			if (head) intro = head + "\n";
		}
	}

	const validCount = specs.filter((s) => s.validity === "valid").length;
	const invalidCount = specs.length - validCount;
	const rows = specs.map(
		(s) =>
			`| [[${escapeMocCell(s.slug)}]] | ${escapeMocCell(s.title)} | ${escapeMocCell(s.status)} | ${escapeMocCell(s.kind)} | ${escapeMocCell(s.updated)} | ${s.validity} |`,
	);
	const graphLinks = specs.map((s) => `[[${s.slug}]]`).join(" · ");

	const md = `${intro}
${MOC_MARKER}

## Specs (${specs.length})

Specs ${specs.length} — ${validCount} valid / ${invalidCount} invalid

| Spec | Title | Status | Kind | Updated | Valid |
|---|---|---|---|---|---|
${rows.join("\n") || "| _(none yet)_ | | | | | |"}

## Graph

${graphLinks || "_(no specs yet)_"}
`;
	fs.writeFileSync(indexPath, md);
	return indexPath;
}
