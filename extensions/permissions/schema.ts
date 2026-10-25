/**
 * Permission config schema (agent-only — no global policy file).
 *
 * Per-agent frontmatter (`agents/*.md`, incl. `agents/main.md` for the
 * main session):
 *   permissions:
 *     defaultAction: deny        # optional — falls back to hardcoded "ask"
 *     rules:
 *       - { tool: bash, match: "...", action: allow }
 *   or: permissions: ./agent-name.permissions.json  (external file, same shape)
 */

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRule {
	tool: string;
	match?: string | string[];
	action: PermissionAction;
}

export interface PermissionsConfig {
	defaultAction: PermissionAction;
	rules: PermissionRule[];
}

export interface ValidatedConfig {
	config: PermissionsConfig;
	errors: string[];
	/** True only when `defaultAction` was explicitly set (matters for distinguishing an explicit agent default from the hardcoded ask fallback). */
	hasDefault: boolean;
}

const ACTIONS: PermissionAction[] = ["allow", "ask", "deny"];

function isAction(v: unknown): v is PermissionAction {
	return typeof v === "string" && (ACTIONS as string[]).includes(v.trim().toLowerCase());
}

function normalizeAction(v: unknown): PermissionAction | null {
	if (!isAction(v)) return null;
	return v.trim().toLowerCase() as PermissionAction;
}

function normalizeMatch(v: unknown): string | string[] | undefined | { error: string } {
	if (v === undefined) return undefined;
	if (typeof v === "string") return v;
	if (Array.isArray(v)) {
		const out: string[] = [];
		for (const item of v) {
			if (typeof item !== "string") return { error: `match array items must be strings, got ${typeof item}` };
			out.push(item);
		}
		return out;
	}
	return { error: `match must be a string or string[], got ${typeof v}` };
}

function validateRule(raw: unknown, index: number): { rule?: PermissionRule; error?: string } {
	if (typeof raw !== "object" || raw === null) return { error: `rules[${index}]: must be an object` };
	const r = raw as Record<string, unknown>;
	if (typeof r.tool !== "string" || !r.tool.trim()) {
		return { error: `rules[${index}]: "tool" must be a non-empty string` };
	}
	let match: string | string[] | undefined;
	if (r.match !== undefined) {
		const m = normalizeMatch(r.match);
		if (typeof m === "object" && m !== null && !Array.isArray(m) && "error" in m) {
			return { error: `rules[${index}]: ${(m as { error: string }).error}` };
		}
		match = m as string | string[] | undefined;
	}
	const action = normalizeAction(r.action);
	if (!action) return { error: `rules[${index}]: "action" must be one of allow|ask|deny` };
	return { rule: { tool: r.tool.trim(), match, action } };
}

/** Validate unknown parsed JSON/frontmatter into a PermissionsConfig. Never throws. */
export function validateConfig(raw: unknown): ValidatedConfig {
	const errors: string[] = [];
	const fallbackDefault: PermissionAction = "ask";
	let defaultAction: PermissionAction = fallbackDefault;
	let hasDefault = false;
	const rules: PermissionRule[] = [];

	if (typeof raw !== "object" || raw === null) {
		return { config: { defaultAction, rules }, errors: ["config must be an object"], hasDefault };
	}
	const obj = raw as Record<string, unknown>;

	if (obj.defaultAction !== undefined) {
		const a = normalizeAction(obj.defaultAction);
		if (!a) errors.push(`"defaultAction" must be one of allow|ask|deny, got ${JSON.stringify(obj.defaultAction)}`);
		else {
			defaultAction = a;
			hasDefault = true;
		}
	}

	if (obj.rules !== undefined) {
		if (!Array.isArray(obj.rules)) {
			errors.push(`"rules" must be an array`);
		} else {
			obj.rules.forEach((item, i) => {
				const { rule, error } = validateRule(item, i);
				if (error) errors.push(error);
				else if (rule) rules.push(rule);
			});
		}
	}

	return { config: { defaultAction, rules }, errors, hasDefault };
}

/** Agent frontmatter `permissions` may be an inline object or a path string. */
export function resolveAgentPermissionsRef(
	frontmatterPermissions: unknown,
): { kind: "inline"; value: unknown } | { kind: "file"; path: string } | { kind: "none" } {
	if (frontmatterPermissions === undefined) return { kind: "none" };
	if (typeof frontmatterPermissions === "string") return { kind: "file", path: frontmatterPermissions };
	if (typeof frontmatterPermissions === "object" && frontmatterPermissions !== null) {
		return { kind: "inline", value: frontmatterPermissions };
	}
	return { kind: "none" };
}
