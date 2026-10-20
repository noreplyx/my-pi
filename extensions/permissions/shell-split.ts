/**
 * Shell chain splitting for permission evaluation.
 *
 * Splits a `bash`/`powershell` command line into segments on shell chaining
 * operators (`;`, `&&`, `||`, `|`, `|&`, `&`, newlines) so each segment can
 * be evaluated against permission rules independently.
 *
 * Combine rule (in loader.ts): any segment `deny` → whole call `deny`;
 * all segments `allow` → `allow`; otherwise `ask`.
 *
 * Quote-aware: delimiters inside single quotes, double quotes, or backticks
 * do not split. Backslash escapes the next character. This is intentionally
 * NOT a full shell parser — `$(…)`, `<()`, redirects (`>`, `<`, `2>&1`)
 * stay inside their segment and are still caught by existing deny
 * substring/regex rules.
 *
 * Pure — safe to unit-test without `pi`.
 */

/** Split a shell command into non-empty trimmed segments. */
export function splitShellCommands(cmd: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: string | null = null; // "'", '"', or "`"
	let escaped = false;

	const push = () => {
		const trimmed = current.trim();
		if (trimmed) segments.push(trimmed);
		current = "";
	};

	let i = 0;
	while (i < cmd.length) {
		const c = cmd[i];
		const next = cmd[i + 1];

		if (escaped) {
			current += c;
			escaped = false;
			i += 1;
			continue;
		}
		if (c === "\\") {
			// Preserve the backslash so downstream regex/glob matching sees
			// the original text, but skip delimiter handling for the next char.
			current += c;
			escaped = true;
			i += 1;
			continue;
		}
		if (quote) {
			current += c;
			if (c === quote) quote = null;
			i += 1;
			continue;
		}
		if (c === "'" || c === '"' || c === "`") {
			quote = c;
			current += c;
			i += 1;
			continue;
		}
		// Delimiters (outside quotes).
		if (c === ";" || c === "\n" || c === "\r") {
			push();
			i += 1;
			continue;
		}
		if (c === "&") {
			const prev = current[current.length - 1];
			const isRedirect =
				((prev !== undefined && /[0-9>]/.test(prev)) && (next !== undefined && /[0-9-]/.test(next))) ||
				next === ">";
			if (isRedirect) {
				// `2>&1`, `>&-`, `&>file` — redirection, not chaining.
				current += c;
				i += 1;
				continue;
			}
			push();
			// Skip `&&` (or lone `&` background) as one delimiter.
			i += next === "&" ? 2 : 1;
			continue;
		}
		if (c === "|") {
			push();
			// Skip `||`, `|&`, or lone `|` as one delimiter.
			if (next === "|" || next === "&") i += 2;
			else i += 1;
			continue;
		}
		current += c;
		i += 1;
	}
	push();
	return segments;
}
