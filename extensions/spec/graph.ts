/**
 * Obsidian graph support: [[wikilinks]] + specs/index.md MOC.
 *
 * `specs/` IS the vault folder (open it directly in Obsidian).
 * Every create/edit/delete rebuilds the MOC so Graph View always shows
 * a hub (index.md) + peer edges ([[wikilinks]] in Related sections).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { slugify } from "./template.ts";

export const SPECS_DIR = "specs";
export const INDEX_FILE = "index.md";
export const ARCHIVE_DIR = "_archived";
const MOC_MARKER = "<!-- spec-index:auto -->";

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

export function listSpecs(cwd: string): SpecEntry[] {
	const dir = specsDir(cwd);
	if (!fs.existsSync(dir)) return [];
	const entries: SpecEntry[] = [];
	for (const f of fs.readdirSync(dir)) {
		if (!f.endsWith(".md") || f === INDEX_FILE) continue;
		const full = path.join(dir, f);
		if (!fs.statSync(full).isFile()) continue;
		const md = fs.readFileSync(full, "utf8");
		const fm = parseFrontmatter(md);
		const slug = f.slice(0, -3);
		entries.push({
			slug,
			title: titleOf(md, slug),
			status: fm.status || "draft",
			kind: fm.kind || "mixed",
			updated: fm.updated || "",
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

	const rows = specs.map(
		(s) => `| [[${s.slug}]] | ${s.title} | ${s.status} | ${s.kind} | ${s.updated} |`,
	);
	const graphLinks = specs.map((s) => `[[${s.slug}]]`).join(" · ");

	const md = `${intro}
${MOC_MARKER}

## Specs (${specs.length})

| Spec | Title | Status | Kind | Updated |
|---|---|---|---|---|
${rows.join("\n") || "| _(none yet)_ | | | | |"}

## Graph

${graphLinks || "_(no specs yet)_"}
`;
	fs.writeFileSync(indexPath, md);
	return indexPath;
}
