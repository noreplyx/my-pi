/** Pure settings helpers (no pi imports — unit-testable with bun test). */

export function extractAuto(raw: unknown): boolean | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const s = raw as Record<string, unknown>;
	if (typeof s.backgroundAuto === "boolean") return s.backgroundAuto;
	const bg = s.background as Record<string, unknown> | undefined;
	if (bg && typeof bg.enabled === "boolean") return bg.enabled;
	return undefined;
}

/** Merge user settings overlaid by project settings. Later defined value wins. */
export function mergeAuto(user: unknown, project: unknown): boolean {
	const fromProject = extractAuto(project);
	if (fromProject !== undefined) return fromProject;
	const fromUser = extractAuto(user);
	if (fromUser !== undefined) return fromUser;
	return false;
}
