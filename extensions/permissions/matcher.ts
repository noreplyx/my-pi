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

/** True when the pattern is (or contains) a regex that never compiles. */
export function hasInvalidRegex(match: string | string[] | undefined): boolean {
	if (match === undefined) return false;
	const patterns = Array.isArray(match) ? match : [match];
	for (const p of patterns) {
		if (typeof p !== "string") continue;
		const rx = isRegexPattern(p.trim());
		if (!rx) continue;
		try {
			new RegExp(rx.body, rx.flags);
		} catch {
			return true;
		}
	}
	return false;
}

export function hasGlobChars(pattern: string): boolean {
	return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

export function globToRegExp(glob: string, pathMode = false): RegExp {
	let re = "";
	let i = 0;
	while (i < glob.length) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				// `**/` → zero or more directories; trailing `**` → everything
				if (glob[i + 2] === "/") {
					re += "(.*/)?";
					i += 3;
				} else {
					re += ".*";
					i += 2;
				}
			} else {
				// Path targets: single `*` stays within one segment (`src/*` matches
				// `src/a` but not `src/a/b`); command targets keep `.*` so
				// `*rm -rf*` matches across `/` in shell strings.
				re += pathMode ? "[^/]*" : ".*";
				i += 1;
			}
		} else if (c === "?") {
			re += pathMode ? "[^/]" : ".";
			i += 1;
		} else if (c === "[") {
			let j = i + 1;
			if (glob[j] === "!" || glob[j] === "^") j += 1;
			if (glob[j] === "]") j += 1; // literal `]` first
			while (j < glob.length && glob[j] !== "]") j += 1;
			if (j < glob.length) {
				let cls = glob.slice(i, j + 1);
				if (cls[1] === "!") cls = "[^" + cls.slice(2);
				re += cls;
				i = j + 1;
			} else {
				re += "\\[";
				i += 1;
			}
		} else if ("+()|^$.{}\\".includes(c)) {
			re += "\\" + c;
			i += 1;
		} else {
			re += c;
			i += 1;
		}
	}
	return new RegExp(`^${re}$`);
}

/** Test one pattern string against one target string. Invalid regex never throws — returns false.
 * `pathMode` selects segment-aware `*`/`?` for file targets. */
export function matchOne(pattern: string, target: string, pathMode = false): boolean {
	const p = pattern.trim();
	if (!p) return true;
	const rx = isRegexPattern(p);
	if (rx) {
		try {
			return new RegExp(rx.body, rx.flags).test(target);
		} catch {
			return false;
		}
	}
	if (hasGlobChars(p)) {
		try {
			return globToRegExp(p, pathMode).test(target);
		} catch {
			return false;
		}
	}
	return target.includes(p);
}

/** `match` field: string | string[] (array = OR). Undefined/empty = match all.
 * `pathMode` applies segment-aware globs (for file-path candidate sets). */
export function matchTargets(match: string | string[] | undefined, candidates: string[], pathMode = false): boolean {
	if (match === undefined) return true;
	const patterns = Array.isArray(match) ? match : [match];
	if (patterns.length === 0) return true;
	for (const p of patterns) {
		if (typeof p !== "string") continue;
		if (!p.trim()) return true;
		for (const target of candidates) {
			if (matchOne(p, target, pathMode)) return true;
		}
	}
	return false;
}

/** Tool-name matching: exact or `*` glob (e.g. `mcp__*`, `*`). Case-sensitive. */
export function matchToolName(pattern: string, toolName: string): boolean {
	const p = pattern.trim();
	if (!p || p === "*") return true;
	if (!hasGlobChars(p) && isRegexPattern(p) === null) return p === toolName;
	return matchOne(p, toolName);
}
