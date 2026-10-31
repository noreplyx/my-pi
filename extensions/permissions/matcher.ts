/**
 * String matching for permission rules.
 *
 * Rule `match` is a single string (or array of strings = OR):
 *   - `re:<body>`        → RegExp test against target (e.g. `re:^git\\s+(status|diff)\\b`)
 *   - `/body/flags`      → RegExp test (e.g. `/^rm\\s+-rf?/i`). A trailing-slash
 *     path (`/foo/bar/`) is NOT a regex — see `isRegexPattern`.
 *   - glob (`*`, `**`, `?`, `[...]`) → glob test (e.g. `src/**`, `**\/.env*`, `*rm -rf*`)
 *   - plain string       → substring test (e.g. `npm publish`)
 *
 * Glob `*`/`?` are path-segment aware for file targets (`src/*` matches
 * `src/a`, not `src/a/b`) but match across `/` for command/JSON targets
 * (`*rm -rf*` must match `echo x; rm -rf /`). Callers select this via the
 * `pathMode` flag on `globToRegExp`/`matchOne`/`matchTargets`.
 *
 * Fail-closed: invalid regex or invalid glob in a `deny` rule matches
 * everything its tool selector matches; in `allow`/`ask` it never matches
 * (see loader.ts firstMatch). Invalid globs: unclosed `[`, trailing
 * backslash, invalid class. `globToRegExp` never throws outward.
 *
 * No dependencies — minimatch is not resolvable from extension paths,
 * so glob support is implemented locally.
 */

export function isRegexPattern(pattern: string): { body: string; flags: string } | null {
	if (pattern.startsWith("re:")) {
		return { body: pattern.slice(3), flags: "" };
	}
	if (pattern.length >= 2 && pattern.startsWith("/")) {
		const lastSlash = pattern.lastIndexOf("/");
		if (lastSlash > 0) {
			const flags = pattern.slice(lastSlash + 1);
			// Flags must be a valid RegExp flag set — otherwise this is a plain
			// absolute path (e.g. `/tmp/scratch/**`), not a `/body/flags` regex.
			if (!/^[gimsuy]*$/.test(flags)) return null;
			const body = pattern.slice(1, lastSlash);
			if (flags === "") {
				// Bare `/…/` with no flags is ambiguous with an absolute path
				// (`/foo/bar/`). Only treat it as a regex when the body contains
				// regex-only syntax. Glob chars (`*?[]`) and `.` alone don't count —
				// `/tmp/*.log/`-style inputs stay paths/globs.
				if (!/[\\^$()|+{}\\]/.test(body)) return null;
			}
			return { body, flags };
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Compiled-pattern caches (bounded ~500 entries, FIFO eviction).
// ---------------------------------------------------------------------------

const MAX_CACHE_ENTRIES = 500;
const regexCache = new Map<string, RegExp>();
const globCache = new Map<string, RegExp>();

function cacheSet(cache: Map<string, RegExp>, key: string, value: RegExp): void {
	if (cache.size >= MAX_CACHE_ENTRIES) {
		const oldest = cache.keys().next();
		if (!oldest.done) cache.delete(oldest.value);
	}
	cache.set(key, value);
}

/** Compile regex via cache. Null = invalid (never throws). */
function cachedRegex(body: string, flags: string): RegExp | null {
	const key = `${body}\0${flags}`;
	const hit = regexCache.get(key);
	if (hit) return hit;
	try {
		const compiled = new RegExp(body, flags);
		cacheSet(regexCache, key, compiled);
		return compiled;
	} catch {
		return null;
	}
}

/** True when the pattern is (or contains) a regex that never compiles. */
export function hasInvalidRegex(match: string | string[] | undefined): boolean {
	if (match === undefined) return false;
	const patterns = Array.isArray(match) ? match : [match];
	for (const pattern of patterns) {
		if (typeof pattern !== "string") continue;
		const parsed = isRegexPattern(pattern.trim());
		if (!parsed) continue;
		if (!cachedRegex(parsed.body, parsed.flags)) return true;
	}
	return false;
}

export function hasGlobChars(pattern: string): boolean {
	return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

/**
 * True for a broken glob: unclosed `[`, trailing unescaped `\`, or a
 * character class / escape sequence whose translated RegExp never compiles
 * (e.g. `[z-a]` — range out of order). Non-glob and regex patterns are
 * never "invalid globs".
 * Fail-closed: deny+bad-glob blocks, allow/ask+bad-glob never matches.
 */
export function hasInvalidGlob(pattern: string): boolean {
	const trimmed = pattern.trim();
	if (!trimmed) return false;
	if (isRegexPattern(trimmed) !== null) return false;
	if (!hasGlobChars(trimmed)) return false;
	// Trailing unescaped backslash.
	let trailing = 0;
	for (let index = trimmed.length - 1; index >= 0 && trimmed[index] === "\\"; index -= 1) trailing += 1;
	if (trailing % 2 === 1) return true;
	// Unclosed `[` (honouring `[!...]`, `[^...]`, literal `]` first).
	for (let index = 0; index < trimmed.length; index += 1) {
		if (trimmed[index] !== "[") continue;
		let cursor = index + 1;
		if (trimmed[cursor] === "!" || trimmed[cursor] === "^") cursor += 1;
		if (trimmed[cursor] === "]") cursor += 1;
		let closed = false;
		while (cursor < trimmed.length) {
			if (trimmed[cursor] === "\\") {
				cursor += 2;
				continue;
			}
			if (trimmed[cursor] === "]") {
				closed = true;
				break;
			}
			cursor += 1;
		}
		if (!closed) return true;
	}
	// Character-class validity depends only on the translated source, not on
	// pathMode (pathMode only changes `*`/`?` translation). A glob whose
	// translation throws (e.g. `[z-a]`) is invalid — without this, a deny
	// rule with such a glob would fail open via the never-matching fallback
	// in globToRegExp.
	try {
		new RegExp(buildGlobSource(trimmed, false));
	} catch {
		return true;
	}
	return false;
}

/** True when the match field holds at least one invalid glob. */
export function hasInvalidGlobMatch(match: string | string[] | undefined): boolean {
	if (match === undefined) return false;
	const patterns = Array.isArray(match) ? match : [match];
	for (const pattern of patterns) {
		if (typeof pattern !== "string") continue;
		if (hasInvalidGlob(pattern)) return true;
	}
	return false;
}

function buildGlobSource(glob: string, pathMode: boolean): string {
	let source = "";
	let index = 0;
	while (index < glob.length) {
		const ch = glob[index];
		if (ch === "*") {
			if (glob[index + 1] === "*") {
				// `**/` → zero or more directories; trailing `**` → everything
				if (glob[index + 2] === "/") {
					source += "(.*/)?";
					index += 3;
				} else {
					source += ".*";
					index += 2;
				}
			} else {
				// Path targets: single `*` stays within one segment (`src/*` matches
				// `src/a` but not `src/a/b`); command targets keep `.*` so
				// `*rm -rf*` matches across `/` in shell strings.
				source += pathMode ? "[^/]*" : ".*";
				index += 1;
			}
		} else if (ch === "?") {
			source += pathMode ? "[^/]" : ".";
			index += 1;
		} else if (ch === "[") {
			let cursor = index + 1;
			if (glob[cursor] === "!" || glob[cursor] === "^") cursor += 1;
			if (glob[cursor] === "]") cursor += 1; // literal `]` first
			while (cursor < glob.length && glob[cursor] !== "]") cursor += 1;
			if (cursor < glob.length) {
				let charClass = glob.slice(index, cursor + 1);
				if (charClass[1] === "!") charClass = "[^" + charClass.slice(2);
				source += charClass;
				index = cursor + 1;
			} else {
				source += "\\[";
				index += 1;
			}
		} else if ("+()|^$.{}\\".includes(ch)) {
			source += "\\" + ch;
			index += 1;
		} else {
			source += ch;
			index += 1;
		}
	}
	return `^${source}$`;
}

/** Never throws outward — falls back to a never-matching pattern. */
export function globToRegExp(glob: string, pathMode = false): RegExp {
	const key = `${glob}\0${pathMode ? "path" : "cmd"}`;
	const hit = globCache.get(key);
	if (hit) return hit;
	try {
		const compiled = new RegExp(buildGlobSource(glob, pathMode));
		cacheSet(globCache, key, compiled);
		return compiled;
	} catch {
		return /^$/;
	}
}

/** Test one pattern string against one target string. Invalid regex/glob never throws — returns false.
 * `pathMode` selects segment-aware `*`/`?` for file targets. */
export function matchOne(pattern: string, target: string, pathMode = false): boolean {
	const trimmed = pattern.trim();
	if (!trimmed) return true;
	const parsed = isRegexPattern(trimmed);
	if (parsed) {
		const compiled = cachedRegex(parsed.body, parsed.flags);
		if (!compiled) return false;
		try {
			return compiled.test(target);
		} catch {
			return false;
		}
	}
	if (hasGlobChars(trimmed)) {
		if (hasInvalidGlob(trimmed)) return false;
		try {
			return globToRegExp(trimmed, pathMode).test(target);
		} catch {
			return false;
		}
	}
	return target.includes(trimmed);
}

/** `match` field: string | string[] (array = OR). Undefined/empty = match all.
 * `pathMode` applies segment-aware globs (for file-path candidate sets). */
export function matchTargets(match: string | string[] | undefined, candidates: string[], pathMode = false): boolean {
	if (match === undefined) return true;
	const patterns = Array.isArray(match) ? match : [match];
	if (patterns.length === 0) return true;
	for (const pattern of patterns) {
		if (typeof pattern !== "string") continue;
		if (!pattern.trim()) return true;
		for (const target of candidates) {
			if (matchOne(pattern, target, pathMode)) return true;
		}
	}
	return false;
}

/** Tool-name matching: exact (case-insensitive) or `*` glob (e.g. `mcp__*`, `*`). */
export function matchToolName(pattern: string, toolName: string): boolean {
	const trimmed = pattern.trim();
	if (!trimmed || trimmed === "*") return true;
	if (!hasGlobChars(trimmed) && isRegexPattern(trimmed) === null) {
		return trimmed.toLowerCase() === toolName.toLowerCase();
	}
	return matchOne(trimmed.toLowerCase(), toolName.toLowerCase());
}
