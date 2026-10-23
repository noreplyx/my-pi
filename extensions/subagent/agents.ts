/**
 * Agent discovery and configuration
 *
 * Trust notes:
 * - Project-local agents (`.pi/agents/*.md`) are repo-controlled content.
 *   Discovery is defensive: malformed files are skipped, symlinks must stay
 *   inside the agents dir, oversized files are skipped, and agent names are
 *   normalized + validated so `Reviewer` cannot shadow `reviewer`.
 * - On name collision under scope `"both"`, the USER agent wins; the
 *   shadowed project agent is reported in `warnings` so the caller can
 *   surface it instead of silently running repo-controlled prompts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	MAX_AGENT_FILE_BYTES,
	MAX_DESCRIPTION_CHARS,
	MAX_SYSTEM_PROMPT_CHARS,
	isValidAgentName,
	normalizeAgentName,
	parseToolList,
} from "./utils.ts";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
	/** True when the agent file declares a `permissions:` block (inline or file ref).
	 *  Permissions are enforced in the child `pi` process via PI_AGENT_NAME/FILE
	 *  (see permissions/loader.ts) — this flag is discovery-time metadata only
	 *  for warnings/previews. Agent permissions beat global, including global deny. */
	hasPermissionsBlock: boolean;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	/** Non-fatal diagnostics (shadowed agents, skipped files). */
	warnings: string[];
}

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear here.
 *
 * A type alias rather than an interface: `parseFrontmatter` constrains its
 * parameter to `Record<string, unknown>`, and only an alias picks up the
 * implicit index signature that satisfies it.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	permissions?: unknown;
};

/**
 * True when `filePath` resolves inside `dir` (symlink-containment check).
 * Rejects dangling links and escapes.
 */
export function isPathInsideDir(dir: string, filePath: string): boolean {
	try {
		const realDir = fs.realpathSync(dir);
		const realFile = fs.realpathSync(filePath);
		return realFile === realDir || realFile.startsWith(realDir + path.sep);
	} catch {
		return false;
	}
}

function loadAgentsFromDir(
	dir: string,
	source: "user" | "project",
	warnings: string[],
): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}
	// Deterministic order across machines (readdir order is unspecified).
	entries.sort((a, b) => a.name.localeCompare(b.name));

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		// Symlink containment: the resolved target must stay inside the
		// agents dir, otherwise a repo could ship `x.md -> ~/.ssh/id_rsa`
		// and have secrets loaded as a system prompt.
		if (entry.isSymbolicLink() && !isPathInsideDir(dir, filePath)) {
			warnings.push(`Skipped ${filePath}: symlink escapes the agents directory.`);
			continue;
		}
		let stat: fs.Stats;
		try {
			stat = fs.statSync(filePath);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue;
		if (stat.size > MAX_AGENT_FILE_BYTES) {
			warnings.push(`Skipped ${filePath}: file exceeds ${MAX_AGENT_FILE_BYTES} bytes.`);
			continue;
		}
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		// A single malformed file must not take down discovery of every
		// other agent (fail-closed per file: skip + warn).
		let frontmatter: AgentFrontmatter;
		let body: string;
		try {
			({ frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content));
		} catch (e) {
			warnings.push(`Skipped ${filePath}: invalid frontmatter (${(e as Error)?.message ?? e}).`);
			continue;
		}

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		const name = frontmatter.name.trim();
		if (!isValidAgentName(normalizeAgentName(name))) {
			warnings.push(
				`Skipped ${filePath}: invalid agent name "${name.slice(0, 60)}" (use lowercase letters, digits, -, _).`,
			);
			continue;
		}

		const parsedTools = parseToolList(frontmatter.tools);
		if (parsedTools.invalid) {
			// Fail closed: a non-string/array `tools` value signals author
			// intent to restrict that we cannot interpret — granting all
			// tools would be the wrong default.
			warnings.push(`Skipped ${filePath}: invalid "tools" value (must be a string or list).`);
			continue;
		}
		if (parsedTools.dropped && parsedTools.dropped.length > 0) {
			warnings.push(`Agent "${name}": dropped invalid tool entries: ${parsedTools.dropped.join(", ")}.`);
		}

		const description =
			frontmatter.description.length > MAX_DESCRIPTION_CHARS
				? frontmatter.description.slice(0, MAX_DESCRIPTION_CHARS)
				: frontmatter.description;
		const systemPrompt =
			body.length > MAX_SYSTEM_PROMPT_CHARS
				? body.slice(0, MAX_SYSTEM_PROMPT_CHARS)
				: body;

		agents.push({
			name,
			description,
			tools: parsedTools.tools,
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt,
			source,
			filePath,
			hasPermissionsBlock: frontmatter.permissions !== undefined,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		// Containment: a symlinked agents dir pointing outside the project
		// tree is not trusted.
		if (isDirectory(candidate)) {
			try {
				const realRoot = fs.realpathSync(currentDir);
				const realCandidate = fs.realpathSync(candidate);
				if (realCandidate === realRoot || realCandidate.startsWith(realRoot + path.sep)) return candidate;
			} catch {
				return null;
			}
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const warnings: string[] = [];
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user", warnings);
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project", warnings);

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		// Project first: on collision the USER agent wins (fail closed —
		// repo content must never silently squat a trusted user name).
		for (const agent of projectAgents) agentMap.set(normalizeAgentName(agent.name), agent);
		for (const agent of userAgents) {
			const key = normalizeAgentName(agent.name);
			if (agentMap.has(key)) {
				const shadowed = agentMap.get(key)!;
				warnings.push(
					`Project agent "${shadowed.name}" (${shadowed.filePath}) is shadowed by user agent "${agent.name}".`,
				);
			}
			agentMap.set(key, agent);
		}
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(normalizeAgentName(agent.name), agent);
	} else {
		for (const agent of projectAgents) agentMap.set(normalizeAgentName(agent.name), agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir, warnings };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
