/**
 * Pure, dependency-free template expansion + validation for the swarm extension.
 *
 * Mirrors the style of `../subagent/utils.ts`: no imports (beyond Buffer),
 * so it runs under plain `bun test` outside the pi runtime.
 */

export const MAX_SWARM_ITEMS = 20;
export const MAX_SWARM_CONCURRENCY = 4;
export const MAX_ITEM_CHARS = 4 * 1024;
export const MAX_TEMPLATE_CHARS = 16 * 1024;
export const MAX_TOTAL_EXPANDED_CHARS = 128 * 1024;

/** True when the template contains at least one literal `{item}`. */
export function hasItemPlaceholder(template: string): boolean {
	return template.includes("{item}");
}

/**
 * Expand `{item}`, `{index}` (1-based) and `{count}` placeholders.
 * Uses a replacer function so `$`-patterns (`$&`, `$'`, `$$`, `$1`)
 * in the item pass through literally.
 */
export function expandTemplate(template: string, item: string, index: number, count: number): string {
	return template.replace(/\{(item|index|count)\}/g, (_match, key: string) => {
		if (key === "item") return item;
		if (key === "index") return String(index);
		return String(count);
	});
}

export function buildSwarmTasks(template: string, items: string[]): string[] {
	return items.map((item, i) => expandTemplate(template, item, i + 1, items.length));
}

export type SwarmInputValidation =
	| { ok: true; template: string; items: string[] }
	| { ok: false; error: string };

/**
 * Validate raw `template` / `items` params. Fail-closed with a human-readable
 * error string; callers surface it with `isError: true`.
 */
export function validateSwarmInput(template: unknown, items: unknown): SwarmInputValidation {
	if (typeof template !== "string" || !template.trim()) {
		return { ok: false, error: "Invalid parameters: `template` must be a non-empty string." };
	}
	const cleanTemplate = template;
	if (cleanTemplate.length > MAX_TEMPLATE_CHARS) {
		return {
			ok: false,
			error: `Invalid parameters: \`template\` exceeds ${MAX_TEMPLATE_CHARS} chars (${cleanTemplate.length}).`,
		};
	}
	if (!hasItemPlaceholder(cleanTemplate)) {
		return {
			ok: false,
			error: "Invalid parameters: `template` must contain `{item}` (otherwise all children would run an identical prompt).",
		};
	}
	if (!Array.isArray(items) || items.length === 0) {
		return { ok: false, error: "Invalid parameters: `items` must be a non-empty array of strings." };
	}
	if (items.length > MAX_SWARM_ITEMS) {
		return {
			ok: false,
			error: `Too many swarm items (${items.length}). Max is ${MAX_SWARM_ITEMS}. Split into multiple swarm calls.`,
		};
	}
	const cleaned: string[] = [];
	for (let i = 0; i < items.length; i++) {
		const raw = items[i];
		if (typeof raw !== "string" || !raw.trim()) {
			return { ok: false, error: `Invalid parameters: \`items[${i}]\` must be a non-empty string.` };
		}
		if (raw.length > MAX_ITEM_CHARS) {
			return {
				ok: false,
				error: `Invalid parameters: \`items[${i}]\` exceeds ${MAX_ITEM_CHARS} chars. Pass a file path and let the child read it instead.`,
			};
		}
		if (raw.trimStart().startsWith("-")) {
			return {
				ok: false,
				error: `Invalid parameters: \`items[${i}]\` must not look like a CLI flag (starts with "-").`,
			};
		}
		cleaned.push(raw);
	}
	let total = 0;
	for (let i = 0; i < cleaned.length; i++) {
		total += Buffer.byteLength(expandTemplate(cleanTemplate, cleaned[i], i + 1, cleaned.length), "utf8");
		if (total > MAX_TOTAL_EXPANDED_CHARS) {
			return {
				ok: false,
				error: `Invalid parameters: expanded prompts exceed ${MAX_TOTAL_EXPANDED_CHARS} bytes total. Reduce items or shorten the template.`,
			};
		}
	}
	return { ok: true, template: cleanTemplate, items: cleaned };
}
