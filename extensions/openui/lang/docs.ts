// Hand-written guidance for each component. The signatures and argument types come from the table in library.ts, so a page
// can never disagree with what the validator accepts; scripts/gen_docs.ts joins the two and test/docs.test.ts checks that
// every example compiles and every screenshot exists.

export interface Shot {
	file: string;
	caption: string;
}

export interface ComponentDoc {
	group: "Layout and text" | "Data" | "Charts" | "Diagrams and maps" | "Interactive" | "Rich content";
	summary: string;
	shots: Shot[];
	/** helper components documented on this page (they only exist inside this one) */
	helpers?: string[];
	use: string[];
	avoid?: string;
	/** notes for the arguments table, keyed "Component.argument" */
	args: Record<string, string>;
	/** OpenUI Lang that compiles; shown as the example */
	example: string;
	exampleNote?: string;
	interaction?: string[];
	tips: string[];
	related: string[];
}

export const DOCS: Record<string, ComponentDoc> = {
	Stack: {
		group: "Layout and text",
		summary: "Lays its children out in a column (the default) or a row. Every widget starts with `root = Stack([...])`.",
		shots: [{ file: "stack", caption: "A row of tiles, then a row of buttons that wraps when it runs out of width" }],
		use: ["The root of every widget.", "A row of metric tiles or buttons.", "Grouping a few components with a chosen gap."],
		avoid: "Do not put a Stack inside a Stack just to add space: use `gap`.",
		args: {
			"Stack.children": "The components inside, top to bottom or left to right. At least one is useful; an empty Stack draws nothing.",
			"Stack.direction": '`"column"` (default) stacks them; `"row"` puts them side by side.',
			"Stack.gap": "Space between children. In a column the steps are none/xs/s = no blank line, m/l = one, xl = two. In a row they are 0, 1, 1, 2, 3 and 4 columns for none, xs, s, m, l, xl. Default `m`.",
			"Stack.wrap": "In a row, start a new line when the next child does not fit.",
		},
		example: `root = Stack([title, row])
title = Text("Two ways to lay out", "heading")
row = Stack([a, b, c], "row", "l")
a = Metric("Left", "1")
b = Metric("Middle", "2")
c = Metric("Right", "3")`,
		tips: [
			"In a row, buttons, metric tiles and short text keep their natural width; every other child shares what is left equally.",
			"A row that is wider than the terminal shrinks its widest children first, never below 6 columns.",
			"Inside Tabs, wrap a tab's content in one Stack: items placed directly in a tab touch each other.",
		],
		related: ["Card", "Tabs", "Text"],
	},
	Text: {
		group: "Layout and text",
		summary: "A line or paragraph of text. It wraps to the available width.",
		shots: [{ file: "text", caption: "The five variants, and the four Callout tones that share this page's screenshot" }],
		use: ["Titles and headings.", "Short explanations next to a chart.", "A muted note or a one-line code fragment."],
		avoid: "For several paragraphs, lists or links use Markdown.",
		args: {
			"Text.text": "The words. `\\n` starts a new line. No markup is interpreted.",
			"Text.variant": "`title` (accent, bold), `heading` (bold), `body` (default), `muted` (dim) or `code`.",
		},
		example: `root = Stack([t1, t2, t3])
t1 = Text("Cluster status", "title")
t2 = Text("Four nodes, all serving.")
t3 = Text("Updated 2 minutes ago", "muted")`,
		tips: ["A word longer than the line is broken rather than cut.", "There is no bold or italic inside Text; use Markdown for that."],
		related: ["Markdown", "Callout"],
	},
	Card: {
		group: "Layout and text",
		summary: "A bordered panel with an optional title in the top border.",
		shots: [{ file: "card", caption: "A card with a nested card" }],
		use: ["Giving a chart or table a heading and a frame.", "Separating sections inside one widget."],
		args: { "Card.children": "The components inside. They are laid out as a column with the default gap.", "Card.title": "Shown in the top border. Cut with an ellipsis if it does not fit." },
		example: `root = Stack([c])
c = Card([chart], "Load by node")
chart = BarChart(["a", "b", "c"], [3, 5, 2])`,
		tips: ["The content is 4 columns narrower than the card: border and padding on both sides.", "Use Tabs for sections the reader switches between, Cards for sections shown together."],
		related: ["Stack", "Tabs"],
	},
	Callout: {
		group: "Layout and text",
		summary: "A highlighted note with an icon: information, success, a warning or an error.",
		shots: [{ file: "callout", caption: "The four tones" }],
		use: ["Drawing the eye to one fact: a failure, a caveat, a result."],
		args: { "Callout.text": "The message. It wraps.", "Callout.tone": "`info` (default, ◉), `success` (✓), `warn` (⚠) or `error` (✗). The icon and border take the theme colour for the tone." },
		example: `root = Stack([a, b])
a = Callout("Disk usage is above 80% on spark-3.", "warn")
b = Callout("Deploy finished without errors.", "success")`,
		tips: ["Keep it to a sentence or two; long text belongs in Markdown."],
		related: ["Text", "Markdown"],
	},
	Metric: {
		group: "Data",
		summary: "A KPI tile: a label, a big value and an optional change line coloured by tone.",
		shots: [{ file: "metric", caption: "Four tones; the last tile carries a tooltip (the ◆ on its border)" }],
		use: ["Headline numbers at the top of a dashboard.", "Status values with a trend."],
		args: {
			"Metric.label": "The small caption on top. This is also the tooltip target.",
			"Metric.value": "The number or word, as a string: `\"87%\"`, `\"4 / 4\"`.",
			"Metric.delta": "The line under the value, for example `\"+4% vs 1h ago\"`.",
			"Metric.tone": "Colours the delta: `good` green, `warn` amber, `bad` red, `neutral` grey.",
			"Metric.tooltips": "At most one, aimed at the label. Write `null` for `delta` and `tone` if you skip them.",
		},
		example: `root = Stack([tiles])
tiles = Stack([a, b], "row")
a = Metric("Requests", "12.4k", "+3%", "good")
b = Metric("p95 latency", "180 ms", "+22 ms", "warn")`,
		tips: ["Values and deltas are strings, so format them yourself.", "Put tiles in a `\"row\"` Stack; in a column each one spans the full width."],
		related: ["BarChart", "Table", "Tooltip"],
	},
	Table: {
		group: "Data",
		summary: "A table with a header row, smart column sizing, and multi-line wrapped cells. Columns that hold only numbers are right-aligned.",
		shots: [
			{ file: "table", caption: "Numbers right-aligned, narrow columns protected, wide prose cells wrapped across lines" },
			{ file: "table-tooltip", caption: "Hovering the row with a tooltip shows its hint in a bubble" },
			{ file: "table-panel", caption: "Clicking it, or pressing Enter, opens the detail panel" },
		],
		use: ["Comparing items across several fields.", "A summary table of steps, findings or metrics with status and prose columns."],
		avoid: "Cramming full multi-paragraph specifications into cells: keep the table as a structured summary and put the full specification in Markdown prose below the widget.",
		args: {
			"Table.columns": "The header strings.",
			"Table.rows": "An array of rows. Each row has exactly one cell per column, a string (up to 1000 characters, `\\n` supported) or a number. A mismatch is a validation error that names the row.",
			"Table.tooltips": "Targets: `row:3` (1-based, not counting the header), `col:status`, or `cell:3.status`. Duplicate header names make `col:` and `cell:` ambiguous.",
		},
		example: `root = Stack([t])
t = Table(["Node", "State", "GPU %"], [["spark-1", "serving", 91], ["spark-2", "draining", 84]], [tip])
tip = Tooltip("row:2", "Rebooting for a driver update")`,
		interaction: ["A tooltip target shows a `◆` in the cell padding after its text.", "Hover, or Tab to the row, for the bubble; click or Enter for the panel."],
		tips: [
			"When the table is wider than the terminal, compact columns (<= 14 chars, such as IDs, step numbers, status or metrics) keep their natural width while wider prose columns share the remaining width proportionally and word-wrap across lines.",
			"A table that still does not fit on a narrow terminal becomes a scrollable window; moving focus to a target scrolls it into view.",
		],
		related: ["Markdown", "Metric", "Tooltip"],
	},
	Tabs: {
		group: "Interactive",
		summary: "A strip of tab labels (`All` plus each tab) over the tab sections. Shows all sections stacked by default and filters to one tab when clicked.",
		helpers: ["TabItem"],
		shots: [
			{ file: "tabs", caption: "All tab sections are shown stacked when the widget is drawn, with interactive pills to filter" },
			{ file: "tabs-nodes", caption: "After clicking Nodes" },
		],
		use: ["Multi-section views of one subject: overview, nodes, notes.", "Grouping related sections that can be read together or isolated by clicking a tab."],
		avoid: "Deeply nested tab hierarchies when simple Cards suffice.",
		args: {
			"Tabs.items": "One TabItem per tab. All tabs are shown stacked in titled cards at the start; clicking a tab filters to it.",
			"TabItem.label": "The text in the strip and section card header. Cut to 22 characters in the strip, and shorter when the strip does not fit.",
			"TabItem.content": "The components in the tab. Wrap them in a single Stack: `[panel]`.",
		},
		example: `root = Stack([tabs])
tabs = Tabs([a, b])
a = TabItem("Overview", [kpis])
kpis = Stack([m1, m2], "row")
m1 = Metric("Nodes up", "4 / 4", "healthy", "good")
m2 = Metric("Queue", "12", "-3", "good")
b = TabItem("Nodes", [tbl])
tbl = Table(["Node", "State"], [["spark-1", "serving"], ["spark-2", "serving"]])`,
		interaction: ["Click a tab (or Tab to it and press Enter) to isolate that section; click `All` or re-click the active tab to return to the stacked all-sections view. Nothing is sent to the assistant.", "Tabs nest, and each remembers its own selection."],
		tips: ["All sections are visible immediately when drawn, so no content is hidden behind an unclicked tab.", "Every TabItem and everything in it must be reachable from `root`, like any other variable."],
		related: ["Card", "Stack"],
	},
	Button: {
		group: "Interactive",
		summary: "A clickable button that sends text to the assistant as your next message.",
		shots: [{ file: "button", caption: "A plain button, one with an action, and a link button" }],
		use: ["Offering the next step: Restart, Show logs, Drain node."],
		args: {
			"Button.label": "The text. A button without an action sends this label.",
			"Button.action": '`@ToAssistant("text")` sends that text (500 characters at most). `Action([...])` holds several steps. `@OpenUrl("https://...")` copies the link to the clipboard, because a terminal cannot open a browser from here.',
		},
		example: `root = Stack([b])
b = Button("Restart vllm", @ToAssistant("Restart the vllm service on dgx-spark-1"))`,
		interaction: [
			"In a widget the agent drew, a click (or Enter on the focused button) stages a confirmation bar, and confirming sends the text as a real user turn. The agent acts, then draws a new widget.",
			"In `/openui-gallery` the click is only echoed locally, so trying it costs nothing.",
		],
		tips: ["Write the action text as a clear instruction: it is what the assistant reads."],
		related: ["Choice", "Faq"],
	},
	Choice: {
		group: "Interactive",
		summary: "A question with a short list of options for you to answer. A click only stages the answer: one **Send answers** button under the widget sends every answer of the widget together, as one message. An option can allow several answers, and every question has an **Other...** row where you type your own.",
		shots: [
			{ file: "choice", caption: "One question with a hint: the tag says Choose one, the options have round indicators, Other... is the last row, and the bar counts" },
			{ file: "choice-card", caption: "Three questions in one Card, two answered. The second allows several answers (square indicators); the third has no Other row" },
			{ file: "choice-other", caption: "Other... opens pi's editor. The text you save shows under the row, and selects it" },
			{ file: "choice-sent", caption: "After Send answers every question is locked, the chosen rows stay marked, and the bar says so" },
		],
		use: [
			"A clarifying question with a few known answers: which node, which environment, yes or no. Ask all of them in ONE widget, in a Card or in Tabs: you answer them together and send once.",
			"A confirmation before something risky, under a Callout that explains the cost.",
			"A question where several answers can be right (`multiple`), or where you may want to say something that is not listed (the Other row).",
		],
		avoid: "a command that should run as written. Use a Button with `@ToAssistant`, which sends exactly the text you give it on one click.",
		args: {
			"Choice.question": "Shown in bold above the options. It is also the first half of the answer sent back. It must have text.",
			"Choice.options": "One row per entry, each with an indicator: a round radio for a single question, a square checkbox for `multiple`. Two to six, each at most 120 characters. A long option wraps under its indicator, so you can read everything that is sent. An empty option is an error.",
			"Choice.hint": "A muted line between the tag and the options. The tag already says `Choose one` or `Choose all that apply`, so do not repeat that here.",
			"Choice.multiple": "`true`: options toggle independently and several can be answered. Default `false`: one answer, and picking another option moves the pick.",
			"Choice.other": "Default `true`: a last row, `Other...`, where you type your own answer. `false` hides it. Write `null` for every skipped argument before it: `Choice(\"Clear the cache?\", [\"Yes\", \"No\"], null, null, false)`.",
		},
		example: `root = Stack([plan])
plan = Card([q1, q2, q3], "Before I restart")
q1 = Choice("Which node should I restart first?", ["web-1", "web-2"])
q2 = Choice("Which checks should I run?", ["Disk", "Memory", "Network"], null, true)
q3 = Choice("Clear the cache on db?", ["Yes", "No"], null, null, false)`,
		exampleNote: "Three questions in one widget: one bar counts and sends them. `null` skips `hint`, and the third question turns the Other row off.",
		interaction: [
			"Click an option, or move with the arrow keys and press Enter. Nothing is sent. In a single question a second click on the chosen option clears it and another option moves the pick; in a `multiple` question each option toggles on its own.",
			"Click Other... (or Enter on it). pi's own editor opens with the question as its title: Enter saves, Shift+Enter adds a line, Esc leaves the answer as it was.",
			"The bar under the widget reads `N of M answered`. **[ Send answers ]** is live once one question is answered; **[ Clear ]** drops every staged answer.",
			"Send answers asks for confirmation and then sends one message and locks every question.",
			"In notes mode the options, Other and the bar do nothing, like a Button.",
		],
		tips: [
			"Ask everything in one widget. A second widget has its own bar and sends its own message.",
			"Write the question and options so `<question> — <option>` still reads as a sentence.",
			"`(no answer)` means skipped. Do not read it as a \"no\".",
			"Options are plain text: no icons, links or per-option descriptions. Put detail in the hint or the question.",
			"At most 12 questions per widget, 6 options each.",
		],
		related: ["Button", "Callout", "Card", "Tabs"],
	},
	Faq: {
		group: "Interactive",
		summary: "A list of questions and answers, expanded by default and collapsible on click.",
		helpers: ["FaqItem"],
		shots: [{ file: "faq", caption: "Answers are open by default and toggle when clicked" }],
		use: ["Q&A entries and collapsible reference material."],
		args: {
			"Faq.items": "One FaqItem per question.",
			"Faq.firstOpen": "Omitted or `true` opens all answers at the start; `false` opens only the first answer and collapses the rest.",
			"FaqItem.question": "The heading.",
			"FaqItem.answer": "Markdown: lists, bold, code and tables all work.",
		},
		example: `root = Stack([f])
f = Faq([a, b], true)
a = FaqItem("What does draining do?", "It stops **new** requests.\\n\\n1. queue pauses\\n2. running requests finish")
b = FaqItem("How do I undo it?", "Run \`uncordon\`.")`,
		interaction: ["Click a question, or Tab to it and press Enter, to open or close it. Each item toggles on its own."],
		tips: ["All answers are open by default unless `firstOpen` is set to `false`."],
		related: ["Markdown", "Tabs"],
	},
	Markdown: {
		group: "Rich content",
		summary: "Formatted text from a markdown string.",
		shots: [
			{ file: "markdown", caption: "Headings, emphasis, lists, a quote, a table, a rule and a link" },
			{ file: "markdown-image", caption: "A picture inside the text, written as a line of its own, with its caption underneath" },
		],
		use: ["Release notes, explanations, anything with structure.", "A README-style view: text with pictures in it."],
		args: { "Markdown.text": "Markdown. Use `\\n` for newlines. Supported: `#`-`######` headings, **bold**, *italic*, `code`, ~~strike~~, `[text](https://example.com)`, lists (nested), `>` quotes, tables, fenced code, `---`, and a picture: a line that is only `![alt](path \"caption\")`." },
		example: `root = Stack([m])
m = Markdown("# Notes\\n\\nThis adds **streaming** and \`--fast\` mode.\\n\\n- faster start\\n- fewer errors\\n\\n![Request flow](flow.png \\"Before and after\\")")`,
		exampleNote: "The picture file must exist when the widget is drawn, as for Image: a missing file is reported to the assistant as an error.",
		tips: [
			"A picture is a line of its own: `![alt](path)`, with an optional caption in quotes after the path. In the middle of a sentence, inside a code fence or inside a quote the syntax stays text. Put a path that has spaces or parentheses in angle brackets.",
			"It is drawn by the same code as [Image](Image.md): a local file or a `data:` URI, sized by pi-tui, the labelled frame where the terminal has no graphics, a missing file or a web URL reported as an error. FAQ answers are markdown too, so they can hold pictures.",
			"A picture in Markdown has no tooltip. Use an Image component when it needs one. A widget holds 12 pictures in all.",
			"Links are shown as `text (url)`; they are not clickable.",
			"Fenced code blocks are highlighted like CodeBlock but have no copy button.",
			"Headings beyond the third level look like the third.",
		],
		related: ["Text", "CodeBlock", "Faq", "Image"],
	},
	CodeBlock: {
		group: "Rich content",
		summary: "Syntax-highlighted code in a frame, with soft line wrapping and a copy button.",
		shots: [{ file: "code", caption: "Highlighting for JavaScript, SQL, YAML, JSON, bash, Go and Rust" }],
		use: ["Commands to run, config to paste, a query."],
		args: {
			"CodeBlock.code": "The source. Use `\\n` for new lines. Tabs become two spaces; up to 400 lines.",
			"CodeBlock.language": "`python`, `js` (also ts, jsx, tsx), `bash` (sh, zsh), `sql`, `yaml`, `json`, `go` or `rust`. Anything else is shown plain.",
			"CodeBlock.title": "A file name or caption in the top border, shown with the language.",
		},
		example: `root = Stack([c])
c = CodeBlock("kubectl rollout restart deploy/api\\nkubectl rollout status deploy/api", "bash", "restart.sh")`,
		interaction: ["Click `[copy]` (or Tab to it and press Enter) to put the exact code on the clipboard with an OSC 52 escape. The label changes to `✓ copied` for two seconds."],
		tips: ["Lines wider than the frame soft-wrap onto continuation rows so no characters are cut. Clicking `[copy]` copies the original unwrapped source.", "The clipboard needs a terminal that accepts OSC 52 (most modern ones do)."],
		related: ["Markdown"],
	},
	Image: {
		group: "Rich content",
		summary: "A picture, drawn for real in terminals that support images, framed, with an optional caption and tooltip.",
		shots: [
			{ file: "image", caption: "A picture inside its frame (generated in code, so the example needs no file)" },
			{ file: "image-tooltip", caption: "Hovering shows the tooltip hint; the frame lights up" },
		],
		use: ["A screenshot or diagram the agent produced.", "Anything where a picture says it better than a chart."],
		args: {
			"Image.src": "A path inside the current workspace or a base64 `data:` URI. PNG, JPEG, GIF or WebP, up to 12 MB. SVG and web URLs are not supported.",
			"Image.alt": "A short name, shown in the frame's top border.",
			"Image.caption": "A line under the picture.",
			"Image.tooltips": "One at most, aimed at the word `image`.",
		},
		example: `root = Stack([i])
i = Image("dashboard.png", "Cluster dashboard", "Taken after the deploy", [t])
t = Tooltip("image", "Screenshot at 14:02", "Taken right after the deploy finished.")`,
		exampleNote: "The path must exist inside the current workspace when the widget is drawn.",
		interaction: ["Hover or Tab to it: the frame turns bold and accent-coloured and the hint bubble appears. Click or Enter opens the tooltip panel."],
		tips: [
			"Pictures use the Kitty graphics protocol: Kitty, Ghostty, WezTerm, Warp and herdr. Elsewhere the frame shows the file name, size and format instead. `PI_IMAGE_PROTOCOL=none` forces that.",
			"pi-tui sizes the picture (at most 64 columns by 22 rows, scaled down to fit) and pi crops it when you scroll, so it behaves like pi's own images.",
			"JPEG, GIF and WebP are converted by pi after startup. For a moment they may show the frame, then the picture.",
			"A tooltip belongs to the whole picture, not to a spot inside it.",
			"A picture can also be written inside a [Markdown](Markdown.md) (or an FAQ answer) as a line `![alt](path)`. It is drawn the same way, but cannot carry a tooltip: use an Image for that.",
		],
		related: ["Tooltip", "Card", "Markdown"],
	},
	BarChart: {
		group: "Charts",
		summary: "Bars for one series of categories. Vertical when it fits, horizontal otherwise.",
		shots: [{ file: "bar", caption: "Vertical bars with a tooltip on one bar, then horizontal bars with a negative value" }],
		use: ["One value per category: load per node, count per type."],
		avoid: "Trends over time with several series (LineChart) or parts of a whole (PieChart).",
		args: {
			"BarChart.labels": "One name per bar.",
			"BarChart.values": "Numbers, same length as `labels`. Mixed signs switch to horizontal bars.",
			"BarChart.title": "A bold line above the chart.",
			"BarChart.unit": "A suffix for the value labels, for example `%`.",
			"BarChart.tooltips": "Target: a bar's label. Duplicate labels are ambiguous. Write `null` for `title` and `unit` if you skip them.",
		},
		example: `root = Stack([c])
c = BarChart(["spark-1", "spark-2", "spark-3"], [91, 84, 77], "GPU load", "%")`,
		tips: ["Bar heights are drawn to an eighth of a cell, so close values still differ.", "Large values are shortened: 12400 is shown as `12.4k`."],
		related: ["LineChart", "PieChart", "Table"],
	},
	LineChart: {
		group: "Charts",
		summary: "Lines over categories, one per series, drawn with braille dots.",
		helpers: ["Series"],
		shots: [
			{ file: "line", caption: "A smooth two-series chart, then a linear and a step chart" },
			{ file: "line-tooltip", caption: "Hovering the Thu column: the ◆ sits on the curve at that point" },
		],
		use: ["Trends with several series: requests per day, latency per hour."],
		args: {
			"LineChart.labels": "The x categories, in order.",
			"LineChart.series": "One Series each. Every series needs one value per label.",
			"LineChart.variant": "`natural` (smooth, default, never overshoots), `linear`, or `step`.",
			"LineChart.xLabel": "Axis caption, shown as `→ day`.",
			"LineChart.yLabel": "Axis caption, shown as `↑ requests`.",
			"LineChart.height": "Roughly in pixels; one terminal row is about 20. Default 200 (10 rows), limited to 6-16 rows.",
			"LineChart.tooltips": "Targets: an x label (that point, hoverable over its whole column) or `series:<name>` (its legend entry).",
			"Series.category": "The series name, shown in the legend.",
			"Series.values": "Numbers parallel to the chart's labels.",
		},
		example: `root = Stack([c])
c = LineChart(["Mon", "Tue", "Wed", "Thu", "Fri"], [api, jobs], "natural", null, null, null, [t])
api = Series("api", [12, 19, 15, 32, 28])
jobs = Series("worker", [8, 11, 14, 12, 18])
t = Tooltip("Thu", "Release v2.3 went out", "Traffic jumped 60% after the release.")`,
		tips: ["The y axis starts at 0, unless the smallest value is at least 60% of the largest: then it starts near the smallest, so small changes stay visible.", "A single point is drawn as a dot."],
		related: ["AreaChart", "BarChart", "RadarChart"],
	},
	AreaChart: {
		group: "Charts",
		summary: "Like LineChart, but the series are stacked and filled, so it shows parts of a growing total.",
		helpers: ["Series"],
		shots: [{ file: "area", caption: "Three stacked series" }],
		use: ["Volume or cumulative totals made of several parts: tokens per model."],
		avoid: "Comparing series directly: stacking hides that. Use LineChart.",
		args: {
			"AreaChart.labels": "The x categories.",
			"AreaChart.series": "One Series each, stacked in order (the first at the bottom).",
			"AreaChart.variant": "`natural` (default), `linear` or `step`.",
			"AreaChart.xLabel": "Axis caption.",
			"AreaChart.yLabel": "Axis caption.",
			"AreaChart.height": "As LineChart.",
			"AreaChart.tooltips": "As LineChart. The badge sits on the top edge of the stack.",
			"Series.category": "The series name.",
			"Series.values": "Numbers parallel to the labels.",
		},
		example: `root = Stack([c])
c = AreaChart(["00:00", "08:00", "16:00"], [a, b])
a = Series("qwen3", [10, 30, 38])
b = Series("llama", [5, 15, 18])`,
		tips: ["The top line is the total of all series."],
		related: ["LineChart", "PieChart"],
	},
	PieChart: {
		group: "Charts",
		summary: "Parts of a whole as a coloured disc with a legend that shows each value and share.",
		shots: [
			{ file: "pie", caption: "A pie, a donut and a semicircle" },
			{ file: "pie-tooltip", caption: "Hovering a legend row (or its wedge) shows the tooltip" },
		],
		use: ["Shares of one total at one moment: memory per model, requests per type."],
		avoid: "More than 8 slices, or close values that should be compared (use BarChart).",
		args: {
			"PieChart.labels": "One name per slice.",
			"PieChart.values": "Raw numbers, not percentages, same length as `labels`, none negative.",
			"PieChart.variant": "`pie` (filled, default) or `donut`.",
			"PieChart.appearance": "`circular` (default) or `semiCircular` (the top half, drawn larger).",
			"PieChart.tooltips": "Target: a slice label. Hover or click either the wedge or its legend row.",
		},
		example: `root = Stack([c])
c = PieChart(["qwen3", "llama", "gemma", "free"], [38, 52, 18, 14], null, null, [t])
t = Tooltip("llama", "Biggest tenant", "Serves the support bot.")`,
		tips: ["Slices are sorted largest first and start at 12 o'clock (9 o'clock for a semicircle).", "The disc is drawn with half blocks in two colours per cell, so it needs a terminal with colour."],
		related: ["BarChart", "AreaChart"],
	},
	RadarChart: {
		group: "Charts",
		summary: "One axis per metric, one polygon per series: comparing entities across several measures.",
		helpers: ["Series"],
		shots: [{ file: "radar", caption: "Two series over five axes" }],
		use: ["Comparing a few options on the same scale: speed, cost, quality."],
		args: {
			"RadarChart.labels": "The axes: at least three.",
			"RadarChart.series": "One Series per entity, each with one value per axis.",
			"RadarChart.tooltips": "Targets: an axis label, or `series:<name>` (its legend entry).",
			"Series.category": "The entity name.",
			"Series.values": "Numbers parallel to the axes. Negative values count as 0.",
		},
		example: `root = Stack([r])
r = RadarChart(["Speed", "Cost", "Quality"], [a, b])
a = Series("qwen3", [80, 90, 70])
b = Series("llama", [55, 60, 88])`,
		tips: ["The scale runs from 0 to a round number above the largest value, printed under the chart."],
		related: ["BarChart", "LineChart"],
	},
	GeoMap: {
		group: "Diagrams and maps",
		summary: "An offline world map zoomed to fit your pins, with optional dashed links.",
		helpers: ["GeoPoint"],
		shots: [
			{ file: "geo", caption: "Four pins and one link on country-scale coastlines" },
			{ file: "geo-tooltip", caption: "A pin's tooltip panel (click or Enter)" },
		],
		use: ["Where regions, offices or servers are."],
		avoid: "City-level detail: the coastlines are 110m, country scale.",
		args: {
			"GeoMap.points": "One GeoPoint per pin.",
			"GeoMap.links": "Optional `[labelA, labelB]` pairs drawn dashed.",
			"GeoMap.title": "A bold line above the map.",
			"GeoMap.tooltips": "Targets: a point's label, or `A>B` for a link.",
			"GeoPoint.label": "The pin's name. Unique within the map.",
			"GeoPoint.lat": "Decimal degrees, -90 to 90.",
			"GeoPoint.lon": "Decimal degrees, -180 to 180.",
			"GeoPoint.tone": "Colours the pin: `good`, `warn`, `bad`, `info` (default) or `neutral`.",
		},
		example: `root = Stack([m])
m = GeoMap([a, b], [["Tokyo", "Frankfurt"]], "Regions")
a = GeoPoint("Tokyo", 35.68, 139.69, "good")
b = GeoPoint("Frankfurt", 50.11, 8.68, "warn")`,
		tips: ["The land is dotted and its coast is drawn solid; the map uses a plain equirectangular projection, with square dots.", "A pin whose label has no room is listed under the map as `also: ...`."],
		related: ["InfraMap"],
	},
	Dag: {
		group: "Diagrams and maps",
		summary: "A directed graph with an automatic layered layout, for pipelines, task graphs and dependencies.",
		helpers: ["DagNode"],
		shots: [
			{ file: "dag", caption: "A CI run with every status: done, failed, running, skipped and pending" },
			{ file: "dag-tooltip", caption: "A focused node: bold accent border, hint bubble, and the tooltip panel below" },
		],
		use: ["A pipeline where each step has a state.", "A fan-out and fan-in.", "Which job waits for which."],
		avoid: "Database tables (Erd) or a plain list of steps (Table).",
		args: {
			"Dag.nodes": "One DagNode per box.",
			"Dag.edges": "`[fromId, toId]` pairs. Use the id strings, not the variable names. An id with no node is a validation error.",
			"Dag.direction": "`LR` (left to right) or `TB` (top to bottom). Leave it out or pass `null` for automatic: left to right when it fits, otherwise top to bottom.",
			"Dag.title": "A bold line above the graph.",
			"Dag.tooltips": "Target: a node id.",
			"DagNode.id": "Unique in the graph. Edges refer to it.",
			"DagNode.label": "The text in the box. Shortened with an ellipsis when space is tight.",
			"DagNode.status": "`done` ✓, `running` ◔, `failed` ✗, `pending` ○ or `skipped` ⊘ (also a dashed box). Omit it for a plain box. A legend names the statuses in use.",
		},
		example: `root = Stack([flow])
flow = Dag([a, b, c], [["build", "test"], ["test", "deploy"]], null, "Release")
a = DagNode("build", "Build", "done")
b = DagNode("test", "Test", "running")
c = DagNode("deploy", "Deploy", "pending")`,
		interaction: ["Each node is a target: hover, Tab or arrows move between them, and a tooltip opens on click or Enter."],
		tips: [
			"A cycle is allowed: the edge that closes it is drawn dashed, pointing back.",
			"Every edge has its own wire, wires cross only at right angles (`┼`), and the layout is checked by decoding the picture back into edges. An edge that truly cannot be routed is left out and listed under the graph as `a -> b (not drawn)`.",
			"Wider than the terminal: labels shrink first, then the direction switches, then the view scrolls sideways.",
		],
		related: ["Erd", "InfraMap", "SequenceDiagram"],
	},
	Erd: {
		group: "Diagrams and maps",
		summary: "An entity-relationship diagram: tables with their columns, and relations with one-or-many ends.",
		helpers: ["Entity", "Relation"],
		shots: [{ file: "erd", caption: "Three tables. `├` or `┤` is the bar (one) and `<` `>` the crow's foot (many)" }],
		use: ["The tables, columns and keys of a schema.", "How tables point at each other."],
		avoid: "Steps that run in order (Dag).",
		args: {
			"Erd.entities": "One Entity per table.",
			"Erd.relations": "One Relation per line.",
			"Erd.title": "A bold line above the diagram.",
			"Erd.tooltips": "Targets: an entity name, or `entity.column`.",
			"Entity.name": "The table name. Relations refer to it.",
			"Entity.fields": 'One string per column: `"name type flags"`, such as `"id uuid PK"` or `"email text UNIQUE"`. `PK` and `FK` are highlighted.',
			"Relation.from": "An entity name.",
			"Relation.to": "An entity name.",
			"Relation.kind": '`"1:N"` (default: the first entity is the one side), `"1:1"`, `"N:1"` or `"N:M"`.',
			"Relation.label": "Short text on the line, such as `owns`.",
		},
		example: `root = Stack([s])
s = Erd([users, projects], [r], "Schema")
users = Entity("users", ["id uuid PK", "email text UNIQUE"])
projects = Entity("projects", ["id uuid PK", "owner_id uuid FK"])
r = Relation("users", "projects", "1:N", "owns")`,
		interaction: ["A table is a target, and so is each column."],
		tips: [
			"Each relation end is one character so the picture stays small: a bar fused with the wire (`├ ┤ ┬ ┴`) means one, a foot facing the table (`< > Λ V`) means many.",
			"Two relations between the same tables are both drawn.",
			"A relation from a table to itself is shown as a `∞` in the title.",
		],
		related: ["Dag", "Table"],
	},
	InfraMap: {
		group: "Diagrams and maps",
		summary: "Zones holding nodes (servers, databases, queues), with labelled arrows showing which talks to which.",
		helpers: ["InfraZone", "InfraNode", "InfraLink"],
		shots: [{ file: "infra", caption: "Three zones, with a degraded worker and a dashed link" }],
		use: ["How a system fits together.", "Where a fault is: nodes carry a status."],
		avoid: "More than about 4 zones and 12 nodes: split it in two.",
		args: {
			"InfraMap.zones": "One InfraZone per box, in order.",
			"InfraMap.links": "One InfraLink per arrow (`[]` for none).",
			"InfraMap.title": "A bold line above the map.",
			"InfraMap.direction": '`"LR"` makes each zone a column (default); `"TB"` makes each zone a row.',
			"InfraMap.tooltips": "Targets: a node id, `zone:<zone name>`, or `<fromId>><toId>` for a link.",
			"InfraZone.name": "The caption in the top border.",
			"InfraZone.nodes": "At least one InfraNode.",
			"InfraZone.tone": "Tints the zone: `neutral` (default), `info`, `good`, `warn`, `bad`.",
			"InfraNode.id": "Unique across the whole map. Links use it.",
			"InfraNode.label": "Bold text in the box.",
			"InfraNode.kind": "Picks the icon: client □, gateway ↔, service ◇, gpu ⌸, database ◎, storage ⊟, queue ≡, cloud ◌.",
			"InfraNode.status": "`up` (green dot), `degraded` (amber), `down` (red) or `unknown` (hollow, dashed box). Omit it for no dot.",
			"InfraNode.detail": "A short second line, such as a port or a count.",
			"InfraLink.from": "The id of the node where the arrow starts (marked with a dot).",
			"InfraLink.to": "The id of the node where it ends (the arrowhead).",
			"InfraLink.label": "A protocol or purpose such as `SQL`, written on the line.",
			"InfraLink.style": "`solid` (default) or `dashed` for an optional or indirect path.",
		},
		example: `root = Stack([m])
m = InfraMap([edge, app], [l], "Platform")
edge = InfraZone("Edge", [lb], "info")
app = InfraZone("App", [api])
lb = InfraNode("lb", "Load balancer", "gateway", "up", "HTTPS :443")
api = InfraNode("api", "API", "service", "degraded", "2 of 3 running")
l = InfraLink("lb", "api", "HTTP")`,
		tips: ["Zones, nodes and links are each tooltip targets.", "Wires may cross a zone border at a right angle but never run along it."],
		related: ["Dag", "SequenceDiagram", "GeoMap"],
	},
	SequenceDiagram: {
		group: "Diagrams and maps",
		summary: "Calls between participants: columns left to right, steps top to bottom, with notes and alt/loop frames.",
		helpers: ["SeqParticipant", "SeqMessage", "SeqNote", "SeqGroup"],
		shots: [{ file: "sequence", caption: "An alt/else frame, a note, a self-call and activation bars" }],
		use: ["The order of calls in a request.", "Who calls whom, and what comes back."],
		avoid: "More than about 5 participants or 20 steps: split it.",
		args: {
			"SequenceDiagram.participants": "One per column.",
			"SequenceDiagram.steps": "Messages, notes and groups in order.",
			"SequenceDiagram.title": "A bold line above.",
			"SequenceDiagram.numbered": "Number the messages (default yes). Pass `false` to turn it off.",
			"SequenceDiagram.tooltips": "Targets: a participant id, or a SeqMessage `id` (a message without an id cannot carry a tooltip).",
			"SeqParticipant.id": "Unique. Messages and notes use it. Keep it short.",
			"SeqParticipant.label": "The header text (22 characters at most).",
			"SeqParticipant.kind": "The header icon: `actor` ⚇, `service` ◇ (default), `database` ◎, `queue` ≡, `external` ◌.",
			"SeqMessage.from": "A participant id. `from` equal to `to` is a self-call (a small loop).",
			"SeqMessage.to": "A participant id.",
			"SeqMessage.label": "Shown above the arrow (48 characters).",
			"SeqMessage.style": "`sync` (solid, filled head, opens an activation bar on the receiver), `async` (solid, open head) or `return` (dashed, open head, closes the bar).",
			"SeqMessage.id": "Only needed to attach a tooltip. Unique.",
			"SeqNote.over": "A participant id.",
			"SeqNote.text": "Wrapped to the note's width.",
			"SeqNote.to": "A second participant: the note spans from `over` to `to`.",
			"SeqGroup.kind": "`alt` (if/else), `opt`, `loop` or `par`.",
			"SeqGroup.label": "Shown in the frame's tab.",
			"SeqGroup.steps": "The messages, notes and groups inside.",
			"SeqGroup.elseSteps": "A second branch below a dashed divider.",
			"SeqGroup.elseLabel": "Names the divider.",
		},
		example: `root = Stack([d])
d = SequenceDiagram([u, api, db], [m1, m2, m3])
u = SeqParticipant("u", "User", "actor")
api = SeqParticipant("api", "API")
db = SeqParticipant("db", "Postgres", "database")
m1 = SeqMessage("u", "api", "GET /item/42")
m2 = SeqMessage("api", "db", "SELECT * FROM items")
m3 = SeqMessage("db", "api", "row", "return")`,
		tips: ["Groups nest up to three deep.", "One SeqGroup per decision: put the other side in `elseSteps`, not in a second group.", "Participant headers are targets for tooltips."],
		related: ["Dag", "InfraMap"],
	},
};

/** Tooltip is a helper of every host, so it has a page of its own. */
export const TOOLTIP_DOC = {
	summary: "A hint and an optional detail panel for one element of a host component. The element shows a `◆`; hover for the hint, click or press Enter for the panel.",
	shots: [
		{ file: "table-tooltip", caption: "Hover: a bubble with the hint appears next to the element" },
		{ file: "table-panel", caption: "Click or Enter: the panel under the widget, with detail, code and a link" },
		{ file: "line-tooltip", caption: "On a line chart the badge sits on the curve" },
		{ file: "pie-tooltip", caption: "On a pie the wedge and its legend row are both the target" },
	],
};
